/**
 * lean_attempt: try tactics, or a standalone snippet, without touching a file.
 *
 * Ported from lean-lsp-mcp attempt_utils.py (MIT, © 2025 Oliver Dressler).
 * Each candidate is spliced into a copy of the file — from `column` (default:
 * the line's first non-space character) to the end of the line, a snippet of n
 * lines replacing n lines — and elaborated in a scratch document that exists
 * only in the server. Lean reuses everything elaborated before the splice, so
 * a candidate costs about what re-checking its own declaration costs.
 *
 * What a candidate is reported with: the goals left at its end, the messages
 * on its own lines, and any *new* message elsewhere — the baseline's messages,
 * shifted by the lines the splice added or removed, are subtracted, so an
 * error that was already there is not blamed on the candidate.
 */

import { LeanToolError } from "../errors.ts";
import type { LeanRuntime } from "../lean/runtime.ts";
import type { DocHandle } from "../lean/server.ts";
import type { Diagnostic } from "../lsp/protocol.ts";
import { type DiagItem, counts, formatItem, summaryLine, toItems } from "./diagnostics.ts";
import { type GoalAt, firstNonSpace, renderGoals, tacticGoalAt } from "./goals.ts";
import { boundText, indent } from "../format.ts";
import { type OpContext, type OpResult, withFile, withNotes } from "./common.ts";
import { requireLeanFile, resolveToolPath, findProjectRoot } from "../lean/project.ts";

export interface AttemptText {
	snippet: string;
	text: string;
	/** 0-based line and codepoint column of the end of the snippet in `text`. */
	goalLine: number;
	goalColumn: number;
	/** Lines added (positive) or removed by the splice. */
	lineDelta: number;
	payloadLines: number;
}

/** `line` 1-based; `targetColumn` 0-based codepoints. Mirrors upstream build_attempt_text. */
export function buildAttemptText(
	lines: readonly string[],
	lineContext: string,
	targetColumn: number,
	snippet: string,
	line: number,
): AttemptText {
	const s = snippet.replace(/\n+$/, "");
	const snippetLines = s ? s.split("\n") : [""];
	const indentText = [...lineContext].slice(0, targetColumn).join("");
	const payload = [indentText + snippetLines[0], ...snippetLines.slice(1).map((p) => indentText + p)];
	const endLine = Math.min(line - 1 + snippetLines.length, lines.length);
	const lineDelta = payload.length - (endLine - (line - 1));
	const text = [...lines.slice(0, line - 1), ...payload, ...lines.slice(endLine)].join("\n") + "\n";
	return {
		snippet: s,
		text,
		goalLine: line - 1 + payload.length - 1,
		goalColumn: [...payload[payload.length - 1]].length,
		lineDelta,
		payloadLines: payload.length,
	};
}

export function identity(d: Diagnostic): string {
	const r = d.range ?? d.fullRange;
	return JSON.stringify([r?.start.line, r?.start.character, r?.end.line, r?.end.character, d.severity, d.code, d.source, d.message]);
}

export function shiftedIdentity(d: Diagnostic, editStart: number, delta: number): string {
	const r = d.range ?? d.fullRange;
	if (!delta || !r || r.start.line < editStart) return identity(d);
	return JSON.stringify([r.start.line + delta, r.start.character, r.end.line + delta, r.end.character, d.severity, d.code, d.source, d.message]);
}

export type Verdict = "closes the goal" | "goals remain" | "fails" | "no tactic state";

export interface AttemptOutcome {
	snippet: string;
	verdict: Verdict;
	goals: GoalAt;
	messages: DiagItem[];
	complete: boolean;
}

/** Scratch line → the user's file: identical before the splice, shifted after it. */
function toFileLine(scratchLine: number, line: number, payload: number, delta: number): number {
	return scratchLine < line + payload ? scratchLine : scratchLine - delta;
}

export interface AttemptInput {
	op: "tactics" | "code";
	path?: string;
	line?: number;
	column?: number;
	snippets?: string[];
	code?: string;
	timeout?: number;
}

async function tryOne(
	scratch: DocHandle,
	a: AttemptText,
	line: number,
	baseline: Set<string> | null,
	oc: OpContext,
	timeoutMs: number,
): Promise<AttemptOutcome> {
	const report = await scratch.diagnostics({ timeoutMs, signal: oc.signal });
	const goals = report.complete
		? await tacticGoalAt(scratch, a.goalLine + 1, a.goalColumn + 1, oc.signal)
		: ({ column: a.goalColumn + 1, status: "still_elaborating", goals: [] } as GoalAt);
	const local: Diagnostic[] = [];
	const extra: Diagnostic[] = [];
	for (const d of report.items) {
		const r = d.range ?? d.fullRange;
		if (r.end.line >= line - 1 && r.start.line <= a.goalLine) local.push(d);
		else if (baseline && !baseline.has(identity(d))) extra.push(d);
	}
	const { items } = toItems([...local, ...extra], scratch.lines, oc.cfg.maxOutputChars);
	for (const i of items) {
		i.line = toFileLine(i.line, line, a.payloadLines, a.lineDelta);
		i.endLine = toFileLine(i.endLine, line, a.payloadLines, a.lineDelta);
	}
	// A candidate that leaves goals open makes Lean report "unsolved goals" on
	// the enclosing block. That is what "goals remain" means, not a failure.
	const errors = items.some((i) => i.severity === "error" && !(goals.status === "goals" && /^unsolved goals/.test(i.message)));
	const verdict: Verdict = errors
		? "fails"
		: goals.status === "complete"
			? "closes the goal"
			: goals.status === "no_goal"
				? "no tactic state"
				: "goals remain";
	return { snippet: a.snippet, verdict, goals, messages: items, complete: report.complete };
}

function renderOutcome(o: AttemptOutcome, n: number, maxChars: number): string {
	const head = `[${n}] ${o.verdict}${o.complete ? "" : " (elaboration incomplete)"}: ${o.snippet.includes("\n") ? `\n${indent(o.snippet, "    ")}` : `\`${o.snippet}\``}`;
	const body: string[] = [];
	if (o.verdict === "goals remain") body.push(indent(renderGoals(o.goals, maxChars)));
	const shown = o.messages.filter((m) => m.severity !== "info" || m.category === "suggestion");
	for (const m of shown) body.push(indent(formatItem(m)));
	return [head, ...body].join("\n");
}

export async function attemptOp(rt: LeanRuntime, input: AttemptInput, oc: OpContext): Promise<OpResult> {
	const timeoutMs = input.timeout ? input.timeout * 1000 : oc.cfg.elaborationTimeoutMs;
	if (input.op === "code") {
		const code = input.code;
		if (!code?.trim()) throw new LeanToolError('code is required for op "code"');
		// Which project's server elaborates it: the one bound, else the one the
		// cwd (or `path`, if given) is in. Imports resolve against that project.
		const anchor = input.path ? resolveToolPath(input.path, oc.cwd) : oc.cwd;
		const root = rt.boundRoot() ?? findProjectRoot(anchor);
		if (!root) {
			throw new LeanToolError(
				"lean_attempt {op: \"code\"} needs a Lake project to elaborate in: run it from inside one, or pass `path` of a file in it.",
			);
		}
		const text = code.endsWith("\n") ? code : `${code}\n`;
		const { value, notes } = await rt.use(
			root,
			(server) =>
				server.withScratch(text, async (doc) => {
					const report = await doc.diagnostics({ timeoutMs, signal: oc.signal });
					const { items } = toItems(report.items, doc.lines, oc.cfg.maxOutputChars);
					const c = counts(items);
					const ok = report.complete && c.errors === 0;
					const lines = [
						ok
							? `the code elaborates${c.sorries ? ` (with ${c.sorries} sorry)` : " without errors"}${items.length ? `: ${summaryLine(items)}` : "."}`
							: report.complete
								? `the code does not elaborate: ${summaryLine(items)}`
								: "elaboration did not finish in time; messages so far:",
						...(report.reopened ? [`Note: ${report.reopened}.`] : []),
						...items.map(formatItem),
					];
					return { text: lines.join("\n"), details: { op: "code", success: ok, complete: report.complete, items } };
				}, { signal: oc.signal }),
			{ signal: oc.signal, onProgress: oc.onProgress },
		);
		return { text: withNotes(value.text, notes), details: value.details };
	}

	if (!input.path) throw new LeanToolError('path is required for op "tactics"');
	if (input.line === undefined) throw new LeanToolError('line is required for op "tactics"');
	const snippets = (input.snippets ?? []).filter((s) => s.trim());
	if (snippets.length === 0) throw new LeanToolError('snippets (one or more tactic candidates) are required for op "tactics"');
	requireLeanFile(resolveToolPath(input.path, oc.cwd));
	const line = input.line;
	const { value, notes } = await withFile(rt, input.path, oc, async (doc, server, { shown }) => {
		doc.pos(line, input.column ?? 1);
		const lineContext = doc.lines[line - 1];
		const target = (input.column ?? firstNonSpace(lineContext)) - 1;
		if (target > [...lineContext].length) {
			throw new LeanToolError(`column ${target + 1} is past the end of line ${line} (${[...lineContext].length} characters)`);
		}
		const base = await doc.diagnostics({ timeoutMs, signal: oc.signal });
		const baselineRaw = base.complete ? base.items : null;
		const outcomes: AttemptOutcome[] = [];
		for (const snippet of snippets) {
			const a = buildAttemptText(doc.lines, lineContext, target, snippet, line);
			const baseline = baselineRaw ? new Set(baselineRaw.map((d) => shiftedIdentity(d, line - 1, a.lineDelta))) : null;
			outcomes.push(await server.withScratch(a.text, (scratch) => tryOne(scratch, a, line, baseline, oc, timeoutMs), { signal: oc.signal }));
		}
		const closing = outcomes.filter((o) => o.verdict === "closes the goal").length;
		const text = [
			`${shown}:${line}: tried ${snippets.length} candidate(s) from column ${target + 1} (the file was not modified); ${closing} close the goal.`,
			...outcomes.map((o, i) => boundText(renderOutcome(o, i + 1, oc.cfg.maxOutputChars), oc.cfg.maxOutputChars * 2)),
		].join("\n");
		return { text, details: { op: "tactics", path: shown, line, column: target + 1, outcomes } };
	});
	return { text: withNotes(value.text, notes), details: value.details };
}
