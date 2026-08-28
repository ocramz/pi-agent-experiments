/**
 * Show the model the kernel as it is now, not as it was.
 *
 * A pi session's transcript only grows: every py_* tool result is appended
 * and stays there. But the kernel recomputes, so a cell re-run ten times
 * leaves ten values in context, nine of them wrong. This runs from the
 * `context` hook, which hands over a deep copy of the messages and takes
 * back a replacement for that one LLM call — the stored session, the
 * session file and what the human sees in the TUI are all untouched.
 *
 * One reverse pass, newest message first. The first execution of a cell it
 * meets is that cell's current value; every earlier one is superseded and
 * loses its payload. Whole-kernel snapshots (the globals/pending/failing
 * tails, an `inspect` dump) survive only on the newest message carrying
 * one, since by construction every older copy describes a kernel that has
 * since moved on.
 *
 * Deliberately pure, and deliberately not in `extensions/index.ts`: that
 * file has no coverage below the live model-driven tier, and this is the
 * part that needs to be cheap to test.
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import {
	SUPERSEDED_INSPECT,
	formatInspect,
	formatResults,
	hasTails,
	type InspectResponse,
	type MutatingResponse,
} from "./format.ts";

export type ContextMessage = ContextEvent["messages"][number];
type ToolResultLike = Extract<ContextMessage, { role: "toolResult" }>;

/** Where a response sat in the kernel's history when it was produced. */
interface Stamp {
	/** Bumped whenever the python process is lost. Nothing survives across one. */
	gen: number;
	/** Bumped by every mutating call, including the ones behind /py commands. */
	mut: number;
}

/**
 * The structured copy of what a py_* tool returned, carried on the tool
 * result's `details`.
 *
 * `details` is persisted to the session file but never serialized to the
 * provider — `convertToolResult` sends only the content, the call id and the
 * error flag — so this is free to carry and survives `--continue`, where an
 * in-memory map would not. Re-rendering from it also means the filter never
 * has to parse its own output back out of a string.
 */
export type PyPayload = {
	/** Appended verbatim after the body. Advice that outlives a re-render. */
	note?: string;
} & (
	| { kind: "py.cells"; response: MutatingResponse }
	| { kind: "py.install"; header: string[]; response: MutatingResponse }
	| { kind: "py.inspect"; response: InspectResponse }
);

export type PyDetails = Stamp & PyPayload;

const RESTARTED = "- superseded by a kernel restart (python state lost)";

const BEACON =
	'\n\nNOTE: the kernel changed outside this transcript (a /py command); the state ' +
	'above may be stale — run py_kernel {op: "inspect"}.';

/** Never mutates `messages` in place: a changed message is a fresh object in a copy. */
export function filterPyContext(messages: ContextMessage[], live: Stamp): ContextMessage[] {
	let out: ContextMessage[] | null = null;
	const claimed = new Set<string>();
	let tailsShown = false;
	let inspectShown = false;
	let newest = true;

	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!isPyResult(m)) continue;
		const d = m.details;

		let text: string;
		if (d.gen < live.gen) {
			// The process that held these values is gone; so are the cells. Nothing
			// in the message is worth a token, and it claims nothing either.
			text = RESTARTED;
		} else {
			text = render(d, { claimed, tails: !tailsShown, inspectShown });
			if (d.kind === "py.inspect") {
				inspectShown = true;
			} else {
				// Both after rendering, so a message never supersedes itself.
				if (!tailsShown) tailsShown = hasTails(d.response);
				claim(d.response, claimed);
			}
			// The beacon covers state changed with no message to show for it. A
			// restart already says everything above is void, so it does not
			// need saying twice.
			if (newest && d.mut < live.mut) text += BEACON;
		}
		newest = false;

		if (text !== currentText(m)) {
			out ??= messages.slice();
			out[i] = { ...m, content: [{ type: "text", text }] };
		}
	}

	return out ?? messages;
}

function render(
	d: PyDetails,
	state: { claimed: ReadonlySet<string>; tails: boolean; inspectShown: boolean },
): string {
	return body(d, state) + (d.note ?? "");
}

function body(
	d: PyDetails,
	state: { claimed: ReadonlySet<string>; tails: boolean; inspectShown: boolean },
): string {
	switch (d.kind) {
		case "py.inspect":
			// A full graph render. A newer one replaces it whole — there is no
			// part of an old dump that a new dump does not restate.
			return state.inspectShown ? SUPERSEDED_INSPECT : formatInspect(d.response);
		case "py.install": {
			// An install with nothing under it is just its header: rendering an
			// empty response would put `ok (nothing to run)` there instead. The
			// tails half of the guard has to agree with `state.tails`, or a
			// re-render that suppresses the snapshot falls into exactly that case.
			const worth =
				Boolean(d.response.results?.length) || (state.tails && hasTails(d.response));
			const results = worth
				? formatResults(d.response, { superseded: state.claimed, tails: state.tails })
				: "";
			return [...d.header, results].filter(Boolean).join("\n");
		}
		case "py.cells":
			return formatResults(d.response, { superseded: state.claimed, tails: state.tails });
	}
}

/**
 * Which cells this response gives a new value to.
 *
 * Only `ran` counts. `cached` asserts the cell is *unchanged* since it last
 * ran, which makes the older message holding its value still current rather
 * than stale — a cached mention claims nothing. `error` claims nothing
 * either: a cell that raises leaves the namespace restored to its last
 * committed value, so the older line is still what the kernel holds.
 */
function claim(resp: MutatingResponse, into: Set<string>): void {
	for (const r of resp.results ?? []) {
		if (r.status === "ran") into.add(r.cell);
	}
}

function isPyResult(m: ContextMessage): m is ToolResultLike & { details: PyDetails } {
	const r = m as { role?: string; details?: { kind?: unknown } };
	return (
		r.role === "toolResult" &&
		typeof r.details?.kind === "string" &&
		r.details.kind.startsWith("py.")
	);
}

function currentText(m: ToolResultLike): string {
	return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
