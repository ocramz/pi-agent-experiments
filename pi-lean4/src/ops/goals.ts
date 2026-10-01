/**
 * lean_goal: the proof state at a position — the tool a prover lives in.
 *
 * Ported from lean-lsp-mcp tools/goals.py (MIT, © 2025 Oliver Dressler).
 * Without a column it reports the goals *before* the line's first token and
 * *after* its last, which is how one tactic's effect reads at a glance.
 */

import { codepointLength } from "../lsp/positions.ts";
import type { PlainGoal, PlainTermGoal } from "../lsp/protocol.ts";
import type { LeanRuntime } from "../lean/runtime.ts";
import type { DocHandle } from "../lean/server.ts";
import { boundText, indent, unfence } from "../format.ts";
import { type OpContext, type OpResult, secondsToMs, withFile, withNotes } from "./common.ts";

export interface GoalInput {
	path: string;
	line: number;
	column?: number;
	kind?: "tactic" | "term";
	timeout?: number;
}

export type GoalStatus = "goals" | "complete" | "no_goal" | "still_elaborating";

export interface GoalAt {
	column: number;
	status: GoalStatus;
	goals: string[];
}

export function firstNonSpace(line: string): number {
	const m = /\S/u.exec(line);
	return m ? [...line.slice(0, m.index)].length + 1 : 1;
}

export async function tacticGoalAt(doc: DocHandle, line: number, column: number, signal?: AbortSignal): Promise<GoalAt> {
	const r = await doc.request<PlainGoal | null>(
		"$/lean/plainGoal",
		{ textDocument: { uri: doc.uri }, position: doc.pos(line, column) },
		{ signal },
	);
	if (!r) return { column, status: "no_goal", goals: [] };
	if (r.goals.length === 0) return { column, status: "complete", goals: [] };
	return { column, status: "goals", goals: r.goals };
}

export function renderGoals(g: GoalAt, maxChars: number): string {
	switch (g.status) {
		case "no_goal":
			return "(no tactic state here — not inside a `by` block?)";
		case "complete":
			return "no goals: the proof is complete at this point";
		case "still_elaborating":
			return "(still elaborating)";
		default:
			return g.goals.map((s, i) => (g.goals.length > 1 ? `case ${i + 1}/${g.goals.length}:\n` : "") + indent(boundText(s, maxChars))).join("\n");
	}
}

export interface GoalDetails {
	path: string;
	line: number;
	lineText: string;
	kind: "tactic" | "term";
	before?: GoalAt;
	after?: GoalAt;
	at?: GoalAt;
	expectedType?: string | null;
}

export async function goalOp(rt: LeanRuntime, input: GoalInput, oc: OpContext): Promise<OpResult<GoalDetails>> {
	const kind = input.kind ?? "tactic";
	const timeoutMs = secondsToMs(input.timeout, oc.cfg.elaborationTimeoutMs);
	const { value, notes } = await withFile(rt, input.path, oc, async (doc, _s, { shown }) => {
		doc.pos(input.line, input.column ?? 1); // validates the line before any waiting
		const lineText = doc.lines[input.line - 1];
		const head = `${shown}:${input.line}: \`${lineText.trim()}\``;
		const details: GoalDetails = { path: shown, line: input.line, lineText, kind };
		const report = await doc.diagnostics({ timeoutMs, signal: oc.signal });
		if (!report.complete) {
			const g: GoalAt = { column: input.column ?? 1, status: "still_elaborating", goals: [] };
			details.at = g;
			return { text: `${head}\nLean is still elaborating this file; call lean_goal again to keep waiting.`, details };
		}
		if (kind === "term") {
			const column = input.column ?? Math.max(1, codepointLength(lineText));
			const r = await doc.request<PlainTermGoal | null>(
				"$/lean/plainTermGoal",
				{ textDocument: { uri: doc.uri }, position: doc.pos(input.line, column) },
				{ signal: oc.signal },
			);
			details.expectedType = r?.goal ? unfence(r.goal) : null;
			return {
				text: details.expectedType
					? `${head}\nexpected type at column ${column}:\n${indent(boundText(details.expectedType, oc.cfg.maxOutputChars))}`
					: `${head}\nno term is being elaborated at column ${column}.`,
				details,
			};
		}
		if (input.column !== undefined) {
			const at = await tacticGoalAt(doc, input.line, input.column, oc.signal);
			details.at = at;
			return { text: `${head}\ngoals at column ${input.column}:\n${renderGoals(at, oc.cfg.maxOutputChars)}`, details };
		}
		const before = await tacticGoalAt(doc, input.line, firstNonSpace(lineText), oc.signal);
		const after = await tacticGoalAt(doc, input.line, codepointLength(lineText) + 1, oc.signal);
		details.before = before;
		details.after = after;
		return {
			text: `${head}\ngoals before:\n${renderGoals(before, oc.cfg.maxOutputChars)}\ngoals after:\n${renderGoals(after, oc.cfg.maxOutputChars)}`,
			details,
		};
	});
	return { text: withNotes(value.text, notes), details: value.details };
}
