/**
 * lean_analyze {op: "hypotheses"}: which explicit hypotheses a theorem needs.
 *
 * Ported from lean-lsp-mcp minimal_hypotheses.py and tools/analysis.py (MIT,
 * © 2025 Oliver Dressler). Each explicit `(h : T)` binder is dropped in turn
 * and the file re-elaborated in a scratch document; an error the original did
 * not have means the binder is load-bearing. Implicit and instance binders are
 * skipped. Report only — nothing is edited, because dropping a hypothesis
 * changes the statement, which is the human's call.
 */

import { LeanToolError } from "../../errors.ts";
import type { LeanRuntime } from "../../lean/runtime.ts";
import type { Diagnostic } from "../../lsp/protocol.ts";
import { type OpContext, type OpResult, withFile, withNotes } from "../common.ts";

export interface Binder {
	text: string;
	start: number;
	end: number;
}

function balancedClose(s: string, open: number, o: string, c: string): number {
	let depth = 0;
	for (let i = open; i < s.length; i++) {
		if (s[i] === o) depth++;
		else if (s[i] === c && --depth === 0) return i;
	}
	return -1;
}

function declRe(name: string): RegExp {
	return new RegExp(`\\b(theorem|lemma|example|def)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_'])`, "u");
}

export function theoremDeclared(source: string, name: string): boolean {
	return declRe(name).test(source);
}

export function theoremBinders(source: string, name: string): Binder[] {
	const m = declRe(name).exec(source);
	if (!m) return [];
	let pos = m.index + m[0].length;
	const out: Binder[] = [];
	const closers: Record<string, string> = { "(": ")", "{": "}", "[": "]", "⦃": "⦄" };
	while (pos < source.length) {
		while (pos < source.length && /\s/.test(source[pos])) pos++;
		const ch = source[pos];
		if (!(ch in closers)) break;
		const close = balancedClose(source, pos, ch, closers[ch]);
		if (close < 0) break;
		out.push({ text: source.slice(pos, close + 1), start: pos, end: close + 1 });
		pos = close + 1;
	}
	return out;
}

export function explicitHypotheses(binders: readonly Binder[]): Binder[] {
	return binders.filter((b) => b.text.startsWith("(") && b.text.includes(":"));
}

export function dropBinder(source: string, b: Binder): string {
	const cut = b.start > 0 && source[b.start - 1] === " " ? b.start - 1 : b.start;
	return source.slice(0, cut) + source.slice(b.end);
}

/**
 * With autoImplicit on — Lean's default outside Mathlib — a dropped `(n : Nat)`
 * comes straight back as an auto-bound implicit and every variable binder looks
 * removable. So the variant switches it off for that one declaration, on the
 * declaration's own line, which keeps every line number of the file the same
 * (the baseline comparison keys on them).
 */
export function withoutAutoImplicit(source: string, name: string): string {
	const m = declRe(name).exec(source);
	if (!m) return source;
	return `${source.slice(0, m.index)}set_option autoImplicit false in ${source.slice(m.index)}`;
}

const key = (d: Diagnostic) => {
	const r = (d.fullRange ?? d.range).start;
	return `${r.line}:${r.character}:${d.message.slice(0, 120)}`;
};

export async function hypothesesOp(rt: LeanRuntime, input: { path: string; name: string; timeout?: number }, oc: OpContext): Promise<OpResult> {
	const bare = input.name.split(".").pop()!;
	const timeoutMs = input.timeout ? input.timeout * 1000 : 60_000;
	const { value, notes } = await withFile(rt, input.path, oc, async (doc, server, { shown }) => {
		if (!theoremDeclared(doc.text, bare)) throw new LeanToolError(`no theorem/lemma/def named ${bare} in ${shown}`);
		const binders = theoremBinders(doc.text, bare);
		const explicit = explicitHypotheses(binders);
		const skipped = binders.length - explicit.length;
		if (explicit.length === 0) {
			return { text: `${input.name}: no explicit (h : T) hypotheses to test${skipped ? ` (${skipped} implicit/instance binder(s) skipped)` : ""}.`, details: { verdicts: [], skipped } };
		}
		const base = await doc.diagnostics({ timeoutMs, signal: oc.signal });
		const baseline = new Set(base.items.filter((d) => d.severity === 1).map(key));
		const verdicts: { binder: string; status: "load-bearing" | "removable" | "error"; breaks?: string[]; detail?: string }[] = [];
		for (const b of explicit) {
			const variant = withoutAutoImplicit(dropBinder(doc.text, b), bare);
			const v = await server.withScratch(
				variant,
				async (scratch) => {
					const r = await scratch.diagnostics({ timeoutMs, signal: oc.signal });
					if (!r.complete) return { binder: b.text, status: "error" as const, detail: `elaboration did not finish within ${Math.round(timeoutMs / 1000)}s` };
					const fresh = r.items.filter((d) => d.severity === 1 && !baseline.has(key(d)));
					return fresh.length
						? { binder: b.text, status: "load-bearing" as const, breaks: fresh.slice(0, 3).map((d) => d.message.split("\n")[0]) }
						: { binder: b.text, status: "removable" as const };
				},
				{ signal: oc.signal },
			);
			verdicts.push(v);
		}
		const lines = [`${shown}: hypotheses of ${input.name} (each dropped in turn on a scratch copy; nothing was edited):`];
		for (const v of verdicts) {
			if (v.status === "removable") lines.push(`- ${v.binder}: REMOVABLE — the proof still elaborates without it`);
			else if (v.status === "load-bearing") lines.push(`- ${v.binder}: load-bearing — without it: ${v.breaks!.join(" | ")}`);
			else lines.push(`- ${v.binder}: unknown — ${v.detail}`);
		}
		if (skipped) lines.push(`(${skipped} implicit/instance binder(s) not tested)`);
		lines.push("Removing a hypothesis changes the statement: report it, do not apply it unasked.");
		return { text: lines.join("\n"), details: { verdicts, skipped } };
	});
	return { text: withNotes(value.text, notes), details: value.details };
}
