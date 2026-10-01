/**
 * lean_diagnostics: what Lean says about a file.
 *
 * Ported from lean-lsp-mcp (diagnostic_utils.py, tools/diagnostics.py; MIT,
 * © 2025 Oliver Dressler): the categories (sorry / suggestion / linter), the
 * hints for failures whose message names a symptom but not a remedy, exact-
 * duplicate removal, and lifting lake's build stderr out of the item list into
 * "failed dependencies".
 *
 * A file still elaborating when the time budget runs out is an *answer*
 * (partial, with the lines not yet done), not an error.
 */

import { LeanToolError } from "../errors.ts";
import type { DiagReport } from "../lean/server.ts";
import type { LeanRuntime } from "../lean/runtime.ts";
import { type Range, rangeFromLsp } from "../lsp/positions.ts";
import { type Diagnostic, type DocumentSymbol, SEVERITY_NAMES } from "../lsp/protocol.ts";
import { boundText, indent, plural } from "../format.ts";
import { type OpContext, type OpResult, secondsToMs, withFile, withNotes } from "./common.ts";

export type Severity = "error" | "warning" | "info" | "hint";
export type Category = "sorry" | "suggestion" | "linter" | "diagnostic";

export interface DiagItem {
	severity: Severity;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	message: string;
	category: Category;
	hint?: string;
}

const LINTER_MARKERS = ["this linter can be disabled", "unused variable", "automatically included section variable"];
const SORRY_MARKERS = ["declaration uses 'sorry'", "declaration uses `sorry`"];

const ERROR_HINTS: [string, string][] = [
	[
		"failed to synthesize instance of type class\n  DecidableEq ",
		"add `classical` locally, or supply the `DecidableEq` instance",
	],
	[
		"synthesized type class instance is not definitionally equal to expression inferred by typing rules",
		"construct both expressions under the same local instance; introduce `classical` before either one when decidability is involved",
	],
	[
		"elaboration function for `Mathlib.Tactic.subscriptTerm` has not been implemented",
		"this notation is not active; open its scoped notation or use the named declaration",
	],
	[
		"deterministic timeout",
		"the elaborator ran out of heartbeats: narrow `simp` with `simp only [...]`, split the proof with `have`, or raise `set_option maxHeartbeats N in` locally",
	],
];
const UNRESOLVED_BINDER = "invalid binder annotation, type is not a class instance";

/** Lake's stderr, published at 1:1 when an import failed to build. A source, not a regex: a shared global regex carries lastIndex between calls. */
const BUILD_ERROR_FILE = String.raw`^(?:error|warning):\s*([^\s:]+\.lean):\d+:\d+:`;

export function categorize(severity: Severity, message: string): Category {
	if (SORRY_MARKERS.some((m) => message.includes(m))) return "sorry";
	if (message.includes("Try this:")) return "suggestion";
	if (severity === "warning" && LINTER_MARKERS.some((m) => message.includes(m))) return "linter";
	return "diagnostic";
}

export function hintFor(severity: Severity, message: string): string | undefined {
	if (severity !== "error") return undefined;
	for (const [marker, hint] of ERROR_HINTS) if (message.includes(marker)) return hint;
	const at = message.indexOf(UNRESOLVED_BINDER);
	if (at >= 0 && message.slice(at + UNRESOLVED_BINDER.length).trim().startsWith("?m.")) {
		return "the binder type is unresolved; check that its class name resolves here (imports, namespace, shadowing) before changing the binder";
	}
	return undefined;
}

export function isBuildStderr(message: string): boolean {
	return message.includes("lake setup-file") || new RegExp(BUILD_ERROR_FILE, "im").test(message);
}

export function failedDependencyPaths(message: string): string[] {
	return [...new Set([...message.matchAll(new RegExp(BUILD_ERROR_FILE, "gim"))].map((m) => m[1]))].sort();
}

/** LSP diagnostics → tool items, in source order, exact repeats dropped. */
export function toItems(
	raw: readonly Diagnostic[],
	lines: readonly string[],
	maxChars: number,
): { items: DiagItem[]; failedDependencies: string[] } {
	const items: DiagItem[] = [];
	let failedDependencies: string[] = [];
	const seen = new Set<string>();
	for (const d of raw) {
		const range = d.fullRange ?? d.range;
		if (!range) continue;
		const severity: Severity = SEVERITY_NAMES[d.severity ?? 1] ?? "error";
		const full = d.message ?? "";
		const { start, end } = rangeFromLsp(lines, range);
		if (start.line === 1 && start.column === 1 && isBuildStderr(full)) {
			failedDependencies = failedDependencyPaths(full);
			continue;
		}
		const key = `${severity}\0${start.line}\0${start.column}\0${full}`;
		if (seen.has(key)) continue;
		seen.add(key);
		items.push({
			severity,
			line: start.line,
			column: start.column,
			endLine: end.line,
			endColumn: end.column,
			message: boundText(full, maxChars),
			category: categorize(severity, full),
			hint: hintFor(severity, full),
		});
	}
	items.sort((a, b) => a.line - b.line || a.column - b.column);
	return { items, failedDependencies };
}

export function counts(items: readonly DiagItem[]): { errors: number; warnings: number; sorries: number; infos: number } {
	return {
		errors: items.filter((i) => i.severity === "error").length,
		warnings: items.filter((i) => i.severity === "warning" && i.category !== "sorry").length,
		sorries: items.filter((i) => i.category === "sorry").length,
		infos: items.filter((i) => i.severity === "info" || i.severity === "hint").length,
	};
}

export function formatItem(i: DiagItem): string {
	const tag = i.category === "diagnostic" ? "" : ` [${i.category}]`;
	const head = `${i.severity}${tag} ${i.line}:${i.column}`;
	const body = i.message.includes("\n") ? `\n${indent(i.message, "    ")}` : ` ${i.message}`;
	return `${head}${body}${i.hint ? `\n    hint: ${i.hint}` : ""}`;
}

export function summaryLine(items: readonly DiagItem[]): string {
	const c = counts(items);
	const parts = [plural(c.errors, "error"), plural(c.warnings, "warning"), plural(c.sorries, "sorry", "sorries")];
	if (c.infos) parts.push(plural(c.infos, "info message"));
	return parts.join(", ");
}

export function lineRanges(processing: readonly Range[], lines: readonly string[]): string {
	return processing
		.map((r) => {
			const { start, end } = rangeFromLsp(lines, r);
			return start.line === end.line ? `${start.line}` : `${start.line}–${end.line}`;
		})
		.join(", ");
}

/** Find a declaration's line range in a documentSymbol tree by (qualified) name. */
export function findDeclaration(
	symbols: readonly DocumentSymbol[],
	name: string,
	prefix = "",
): DocumentSymbol | null {
	for (const s of symbols) {
		const full = prefix ? `${prefix}.${s.name}` : s.name;
		if (s.name === name || full === name || full.endsWith(`.${name}`)) return s;
		const hit = findDeclaration(s.children ?? [], name, s.kind === 3 || s.kind === 2 ? full : prefix);
		if (hit) return hit;
	}
	return null;
}

export interface DiagnosticsInput {
	path: string;
	startLine?: number;
	endLine?: number;
	declaration?: string;
	severity?: Severity;
	timeout?: number;
}

export interface DiagnosticsDetails {
	path: string;
	version: number;
	complete: boolean;
	items: DiagItem[];
	failedDependencies: string[];
	stillElaborating?: string;
	reopened?: string;
	range?: [number, number];
	clean: boolean;
}

export function formatReport(
	shown: string,
	report: DiagReport,
	items: DiagItem[],
	failedDependencies: string[],
	lines: readonly string[],
	scope: string,
	totalInFile: number,
): string {
	const out: string[] = [];
	if (report.reopened) out.push(`Note: ${report.reopened}.`);
	if (!report.complete) {
		out.push(
			`${shown}: Lean is still elaborating (not finished: lines ${lineRanges(report.processing, lines) || "?"}). ` +
				"These are the messages so far; call again to keep waiting.",
		);
	}
	if (report.fatal) out.push("Lean reported a fatal error processing this file (see the messages at its header).");
	if (failedDependencies.length) {
		out.push(`Imports failed to build: ${failedDependencies.join(", ")}. Fix those files first (lean_diagnostics on each).`);
	}
	if (items.length === 0) {
		if (report.complete && totalInFile === 0) out.push(`${shown}: no errors, warnings or sorries — the file elaborates cleanly.`);
		else if (report.complete) out.push(`${shown}: nothing ${scope} (${plural(totalInFile, "message")} elsewhere in the file).`);
		else out.push("(no messages yet)");
		return out.join("\n");
	}
	out.push(`${shown}${scope ? ` ${scope}` : ""}: ${summaryLine(items)}${report.complete ? "" : " so far"}`);
	for (const i of items) out.push(formatItem(i));
	return out.join("\n");
}

export async function diagnosticsOp(rt: LeanRuntime, input: DiagnosticsInput, oc: OpContext): Promise<OpResult<DiagnosticsDetails>> {
	const timeoutMs = secondsToMs(input.timeout, oc.cfg.elaborationTimeoutMs);
	const { value, notes } = await withFile(rt, input.path, oc, async (doc, _server, { shown }) => {
		const report = await doc.diagnostics({ timeoutMs, signal: oc.signal });
		const { items: all, failedDependencies } = toItems(report.items, doc.lines, oc.cfg.maxOutputChars);
		let start = input.startLine;
		let end = input.endLine;
		let scope = "";
		if (input.declaration) {
			const symbols = (await doc.request<DocumentSymbol[] | null>("textDocument/documentSymbol", { textDocument: { uri: doc.uri } })) ?? [];
			const sym = findDeclaration(symbols, input.declaration);
			if (!sym) throw new LeanToolError(`no declaration named ${input.declaration} in ${shown} (lean_nav {op: "outline"} lists them)`);
			const r = rangeFromLsp(doc.lines, sym.range);
			start = r.start.line;
			end = r.end.line;
			scope = `in ${input.declaration} (lines ${start}–${end})`;
		} else if (start !== undefined || end !== undefined) {
			scope = `in lines ${start ?? 1}–${end ?? doc.lines.length}`;
		}
		const items = all.filter(
			(i) =>
				(start === undefined || i.endLine >= start) &&
				(end === undefined || i.line <= end) &&
				(!input.severity || i.severity === input.severity),
		);
		if (input.severity) scope = `${scope}${scope ? ", " : ""}severity ${input.severity}`;
		const text = formatReport(shown, report, items, failedDependencies, doc.lines, scope, all.length);
		const details: DiagnosticsDetails = {
			path: shown,
			version: report.version,
			complete: report.complete,
			items,
			failedDependencies,
			stillElaborating: report.complete ? undefined : lineRanges(report.processing, doc.lines),
			reopened: report.reopened,
			range: start !== undefined || end !== undefined ? [start ?? 1, end ?? doc.lines.length] : undefined,
			clean: report.complete && all.every((i) => i.severity !== "error" && i.category !== "sorry"),
		};
		return { text, details };
	});
	return { text: withNotes(value.text, notes), details: value.details };
}
