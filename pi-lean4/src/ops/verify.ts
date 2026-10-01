/**
 * lean_verify {op: "axioms"}: what a theorem actually rests on.
 *
 * Ported from lean-lsp-mcp verify.py (MIT, © 2025 Oliver Dressler): `#print
 * axioms` runs on a scratch copy of the file — never on the file itself, unlike
 * lean4-skills' check_axioms_inline.sh, which appended to the user's source and
 * restored it afterwards — and the result is classified by its worst axiom.
 * The source scan for soundness-relevant constructs runs in-process, so it
 * needs no ripgrep.
 */

import { LeanToolError } from "../errors.ts";
import type { LeanRuntime } from "../lean/runtime.ts";
import type { Diagnostic } from "../lsp/protocol.ts";
import { codeLines, declarations } from "./decls.ts";
import { type OpContext, type OpResult, withFile, withNotes } from "./common.ts";

export const STANDARD_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);
const INCOMPLETE = new Set(["sorryAx"]);
const NATIVE = new Set(["Lean.ofReduceBool", "Lean.trustCompiler"]);
const NATIVE_DECIDE = /(?:^|\.)_native\.native_decide\.ax(?:_\d+)*$/;

export type Trust = "standard" | "incomplete" | "native" | "custom";

export function classifyAxioms(axioms: readonly string[]): { trust: Trust; nonStandard: string[] } {
	const nonStandard = axioms.filter((a) => !STANDARD_AXIOMS.has(a));
	if (axioms.some((a) => INCOMPLETE.has(a))) return { trust: "incomplete", nonStandard };
	if (axioms.some((a) => NATIVE.has(a) || NATIVE_DECIDE.test(a))) return { trust: "native", nonStandard };
	if (nonStandard.length) return { trust: "custom", nonStandard };
	return { trust: "standard", nonStandard };
}

/** One `#print axioms` message → its axioms, `[]` for none, null if it is not one. */
export function parseAxiomMessage(message: string): string[] | null {
	const flat = message.replace(/\s+/g, " ");
	if (/does not depend on any axioms/.test(flat)) return [];
	const m = /depends on axioms:\s*\[(.*?)\]/.exec(flat);
	return m ? m[1].split(",").map((a) => a.trim()).filter(Boolean) : null;
}

export const WARNING_PATTERNS: [RegExp, string][] = [
	[/set_option\s+debug\./, "set_option debug.*"],
	[/\bunsafe\b/, "unsafe"],
	[/@\[implemented_by\b/, "@[implemented_by]"],
	[/@\[extern\b/, "@[extern]"],
	[/\bopaque\b/, "opaque"],
	[/local\s+instance\b/, "local instance"],
	[/local\s+notation\b/, "local notation"],
	[/local\s+macro_rules\b/, "local macro_rules"],
	[/scoped\s+notation\b/, "scoped notation"],
	[/scoped\s+instance\b/, "scoped instance"],
	[/@\[csimp\b/, "@[csimp]"],
	[/import\s+Lean\.Elab\b/, "import Lean.Elab"],
	[/import\s+Lean\.Meta\b/, "import Lean.Meta"],
	[/^\s*axiom\b/, "axiom declaration"],
];

/** Constructs that can change what a proof means. A list to look at, not a verdict. */
export function scanSource(text: string): { line: number; pattern: string }[] {
	const out: { line: number; pattern: string }[] = [];
	codeLines(text).forEach((code, i) => {
		for (const [re, label] of WARNING_PATTERNS) {
			if (re.test(code)) {
				out.push({ line: i + 1, pattern: label });
				break;
			}
		}
	});
	return out;
}

export const NAME_RE = /^[\p{L}_][\p{L}\p{N}_'!?]*(?:\.[\p{L}_][\p{L}\p{N}_'!?]*)*$/u;

export interface AxiomVerdict {
	name: string;
	axioms: string[] | null;
	trust: Trust | "error";
	nonStandard: string[];
	error?: string;
}

export interface VerifyInput {
	path: string;
	name?: string;
	scanSource?: boolean;
}

export async function axiomsOp(rt: LeanRuntime, input: VerifyInput, oc: OpContext): Promise<OpResult> {
	const { value, notes } = await withFile(rt, input.path, oc, async (doc, server, { shown }) => {
		let names: string[];
		let skippedPrivate = 0;
		if (input.name) {
			const n = input.name.replace(/^_root_\./, "");
			if (!NAME_RE.test(n)) throw new LeanToolError(`${input.name} is not a Lean name; give it fully qualified, e.g. \`Namespace.theorem\``);
			names = [n];
		} else {
			const decls = declarations(doc.text).filter((d) => (d.keyword === "theorem" || d.keyword === "lemma") && d.qualified);
			skippedPrivate = decls.filter((d) => d.private).length;
			names = decls.filter((d) => !d.private).map((d) => d.qualified!);
			if (names.length === 0) {
				throw new LeanToolError(`${shown} declares no (non-private) theorem or lemma; pass name to check a definition`);
			}
		}
		const body = doc.text.replace(/\s+$/, "");
		const firstCheck = body.split("\n").length + 1; // 0-based line of the first #print
		const text = `${body}\n\n${names.map((n) => `#print axioms _root_.${n}`).join("\n")}\n`;
		const verdicts = await server.withScratch(
			text,
			async (scratch) => {
				const report = await scratch.diagnostics({ signal: oc.signal });
				if (!report.complete) throw new LeanToolError("the axiom check did not finish elaborating in time");
				const byLine = new Map<number, Diagnostic[]>();
				for (const d of report.items) {
					const l = (d.fullRange ?? d.range).start.line;
					if (l < firstCheck) continue;
					byLine.set(l, [...(byLine.get(l) ?? []), d]);
				}
				return names.map((name, k): AxiomVerdict => {
					const ds = byLine.get(firstCheck + k) ?? [];
					const err = ds.find((d) => d.severity === 1);
					if (err) return { name, axioms: null, trust: "error", nonStandard: [], error: err.message.split("\n")[0] };
					for (const d of ds) {
						const axioms = parseAxiomMessage(d.message);
						if (axioms) return { name, axioms, ...classifyAxioms(axioms) };
					}
					return { name, axioms: null, trust: "error", nonStandard: [], error: "no #print axioms output (elaboration did not reach the check)" };
				});
			},
			{ signal: oc.signal },
		);
		const warnings = input.scanSource === false ? [] : scanSource(doc.text);
		const lines = [`${shown}: axioms of ${names.length === 1 ? names[0] : `${names.length} theorems`}`];
		for (const v of verdicts) {
			if (v.trust === "error") lines.push(`- ${v.name}: could not check — ${v.error}`);
			else if (v.trust === "standard") lines.push(`- ${v.name}: standard${v.axioms!.length ? ` (${v.axioms!.join(", ")})` : " (no axioms)"}`);
			else if (v.trust === "incomplete") lines.push(`- ${v.name}: INCOMPLETE — depends on sorryAx: the proof (or something it uses) contains sorry`);
			else if (v.trust === "native") lines.push(`- ${v.name}: NATIVE — trusts compiled code (native_decide / ofReduceBool): ${v.nonStandard.join(", ")}`);
			else lines.push(`- ${v.name}: CUSTOM AXIOMS — ${v.nonStandard.join(", ")}`);
		}
		if (skippedPrivate) lines.push(`(${skippedPrivate} private theorem(s) skipped: private names cannot be addressed from the check)`);
		if (warnings.length) {
			lines.push(`source scan: ${warnings.length} construct(s) worth a look (they can change what a proof means):`);
			for (const w of warnings) lines.push(`  line ${w.line}: ${w.pattern}`);
		}
		const allStandard = verdicts.every((v) => v.trust === "standard");
		return { text: lines.join("\n"), details: { op: "axioms", path: shown, verdicts, warnings, allStandard } };
	});
	return { text: withNotes(value.text, notes), details: value.details };
}
