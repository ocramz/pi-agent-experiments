/**
 * The autoprove loop's state machine, with no pi in it.
 *
 * `/lean autoprove <file>` runs the lean4-prove skill's cycle repeatedly
 * without asking, under budgets taken from lean4-skills' autoprove command
 * (MIT): at most 20 cycles, at most 3 stuck cycles in a row, at most 120
 * minutes of running time. The extension owns the loop — it measures progress
 * itself after every turn (sorries and errors in the target file), decides
 * whether to go on, and says why it stopped. The model's own status block is
 * advice, never the measurement.
 *
 * Progress is: fewer sorries with no more errors, or fewer errors with no more
 * sorries. Anything else — including trading a sorry for an error — is a stuck
 * cycle. Running time counts only while the loop is active, so a session that
 * is paused and resumed tomorrow does not wake up over budget.
 */

export type StopReason = "completion" | "max-cycles" | "max-stuck" | "max-runtime" | "user-stop" | "error";

export interface Measure {
	sorries: number;
	errors: number;
	/** Where the first remaining problem is, for the next cycle's message. */
	focus: string | null;
}

export interface Budget {
	maxCycles: number;
	maxStuck: number;
	maxRuntimeMs: number;
}

export interface AutoproveState {
	v: 1;
	file: string;
	root: string;
	budget: Budget;
	status: "running" | "paused" | "stopped";
	cycles: number;
	stuckStreak: number;
	activeMs: number;
	segmentStart: number | null;
	startedAt: number;
	baseline: Measure;
	last: Measure;
	history: { cycle: number; sorries: number; errors: number; stuck: boolean }[];
	stop?: { reason: StopReason; detail?: string };
}

export const DEFAULT_BUDGET: Budget = { maxCycles: 20, maxStuck: 3, maxRuntimeMs: 120 * 60_000 };

export function start(file: string, root: string, measure: Measure, budget: Budget, now: number): AutoproveState {
	return {
		v: 1,
		file,
		root,
		budget,
		status: "running",
		cycles: 0,
		stuckStreak: 0,
		activeMs: 0,
		segmentStart: now,
		startedAt: now,
		baseline: measure,
		last: measure,
		history: [],
	};
}

export function isDone(m: Measure): boolean {
	return m.sorries === 0 && m.errors === 0;
}

export function isProgress(prev: Measure, next: Measure): boolean {
	return (next.sorries < prev.sorries && next.errors <= prev.errors) || (next.errors < prev.errors && next.sorries <= prev.sorries);
}

function elapsed(s: AutoproveState, now: number): number {
	return s.activeMs + (s.segmentStart !== null ? now - s.segmentStart : 0);
}

export type Decision = { kind: "continue"; state: AutoproveState } | { kind: "stop"; state: AutoproveState; reason: StopReason };

function stopped(s: AutoproveState, reason: StopReason, now: number, detail?: string): Decision {
	return {
		kind: "stop",
		reason,
		state: { ...s, status: "stopped", activeMs: elapsed(s, now), segmentStart: null, stop: { reason, detail } },
	};
}

/** One turn ended: measure, update, decide. */
export function boundary(s: AutoproveState, m: Measure, run: { aborted: boolean; error?: string }, now: number): Decision {
	if (run.aborted) return stopped({ ...s, last: m }, "user-stop", now, "the run was interrupted");
	if (run.error) return stopped({ ...s, last: m }, "error", now, run.error);
	const cycles = s.cycles + 1;
	const stuck = !isProgress(s.last, m);
	const next: AutoproveState = {
		...s,
		cycles,
		stuckStreak: stuck ? s.stuckStreak + 1 : 0,
		last: m,
		history: [...s.history, { cycle: cycles, sorries: m.sorries, errors: m.errors, stuck }],
	};
	if (isDone(m)) return stopped(next, "completion", now);
	if (next.stuckStreak >= s.budget.maxStuck) return stopped(next, "max-stuck", now, `${next.stuckStreak} cycles in a row without progress`);
	if (cycles >= s.budget.maxCycles) return stopped(next, "max-cycles", now);
	if (elapsed(next, now) >= s.budget.maxRuntimeMs) return stopped(next, "max-runtime", now);
	return { kind: "continue", state: next };
}

export function pause(s: AutoproveState, now: number): AutoproveState {
	if (s.status !== "running") return s;
	return { ...s, status: "paused", activeMs: elapsed(s, now), segmentStart: null };
}

export function resume(s: AutoproveState, now: number): AutoproveState {
	if (s.status !== "paused") return s;
	return { ...s, status: "running", segmentStart: now };
}

export function userStop(s: AutoproveState, now: number, detail = "stopped by the user"): AutoproveState {
	return stopped(s, "user-stop", now, detail).state;
}

/** The latest saved state on a branch, with a run that was live demoted to paused. */
export function restore(entries: readonly unknown[], now: number): AutoproveState | null {
	let found: AutoproveState | null = null;
	for (const e of entries) {
		const entry = e as { type?: string; customType?: string; data?: unknown };
		if (entry?.type === "custom" && entry.customType === "lean-autoprove" && (entry.data as AutoproveState)?.v === 1) {
			found = entry.data as AutoproveState;
		}
	}
	if (!found) return null;
	return found.status === "running" ? pause(found, now) : found;
}

export function parseArgs(args: string, defaults: Budget): { file?: string; budget: Budget; resume: boolean; error?: string } {
	const budget = { ...defaults };
	let file: string | undefined;
	let resumeFlag = false;
	for (const tok of args.trim().split(/\s+/).filter(Boolean)) {
		let m: RegExpExecArray | null;
		if (tok === "resume") resumeFlag = true;
		else if ((m = /^--max-cycles=(\d+)$/.exec(tok))) budget.maxCycles = Math.max(1, Number(m[1]));
		else if ((m = /^--max-stuck(?:-cycles)?=(\d+)$/.exec(tok))) budget.maxStuck = Math.max(1, Number(m[1]));
		else if ((m = /^--max-runtime=(\d+)(m|h|s)?$/.exec(tok))) {
			const n = Number(m[1]);
			budget.maxRuntimeMs = Math.max(1000, n * (m[2] === "h" ? 3_600_000 : m[2] === "s" ? 1000 : 60_000));
		} else if (tok.startsWith("--")) return { budget, resume: resumeFlag, error: `unknown option ${tok}` };
		else if (file) return { budget, resume: resumeFlag, error: `one file at a time (got ${file} and ${tok})` };
		else file = tok;
	}
	return { file, budget, resume: resumeFlag };
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)}m`;

export function kickoffText(s: AutoproveState, shown: string): string {
	return [
		`[lean autoprove] cycle 1/${s.budget.maxCycles} target=${shown} commit=auto deep=stuck`,
		`The file has ${s.last.sorries} sorry(ies) and ${s.last.errors} error(s)${s.last.focus ? `; first: ${s.last.focus}` : ""}.`,
		`Budgets: ${s.budget.maxCycles} cycles, ${s.budget.maxStuck} stuck cycles in a row, ${minutes(s.budget.maxRuntimeMs)} of running time. ` +
			"The extension measures progress after every turn and starts the next cycle itself: do one cycle, end your turn with the <autoprove-status> block, and do not ask questions.",
	].join("\n");
}

export function cycleText(s: AutoproveState, shown: string): string {
	const last = s.history[s.history.length - 1];
	return [
		`[lean autoprove] cycle ${s.cycles + 1}/${s.budget.maxCycles} target=${shown}`,
		`Measured after cycle ${s.cycles}: ${s.last.sorries} sorry(ies), ${s.last.errors} error(s)` +
			(last?.stuck ? ` — no progress (stuck ${s.stuckStreak}/${s.budget.maxStuck}): change approach (search differently, try a helper lemma, or the escalation pass).` : " — progress."),
		...(s.last.focus ? [`Next: ${s.last.focus}`] : []),
		"Continue with the next cycle of the lean4-prove autoprove mode.",
	].join("\n");
}

export function summaryText(s: AutoproveState, shown: string): string {
	const reason: Record<StopReason, string> = {
		completion: "every sorry is filled and the file compiles",
		"max-cycles": `the cycle budget (${s.budget.maxCycles}) is spent`,
		"max-stuck": `${s.budget.maxStuck} cycles in a row made no progress`,
		"max-runtime": `the running-time budget (${minutes(s.budget.maxRuntimeMs)}) is spent`,
		"user-stop": "it was stopped",
		error: "a run failed",
	};
	const r = s.stop?.reason ?? "user-stop";
	return [
		`[lean autoprove] stopped after ${s.cycles} cycle(s), ${minutes(s.activeMs)}: ${reason[r]}${s.stop?.detail ? ` (${s.stop.detail})` : ""}.`,
		`${shown}: sorries ${s.baseline.sorries} → ${s.last.sorries}, errors ${s.baseline.errors} → ${s.last.errors}.`,
		r === "completion"
			? "Verify with lean_verify {op: \"axioms\"} before calling it done."
			: "Summarise what was filled, what is left and the blocker for each remaining sorry, as the lean4-prove skill's session summary describes.",
	].join("\n");
}
