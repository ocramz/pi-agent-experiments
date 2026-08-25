// What a case asserts on after the pi session ends.
//
// Two records of the same run, which is what makes the filter checkable:
//
//   turns()        what pi handed the provider — filtered, one file per call
//   sessionText()  what pi wrote to the session file — unfiltered, always
//
// The filter is supposed to change the first and never the second, so having
// both means non-destructiveness falls out of the same fixture rather than
// needing a case of its own.
//
// Everything is read-only and opened per call: these run after pi has exited.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sessionFilesFor } from "../../../shared/test/tui/pi-session.ts";
import { FAUX_DIR } from "./faux-script.ts";

export interface RecordedMessage {
	role: string;
	toolCallId?: string;
	toolName?: string;
	content: string | { type: string; text?: string; id?: string; name?: string }[];
}

/** The messages pi handed the provider for one call. */
export type RecordedTurn = RecordedMessage[];

export interface Inspector {
	/** Every recorded turn, in the order the provider was asked. */
	turns(): RecordedTurn[];
	/** One turn, numbered from 1. */
	turn(n: number): RecordedTurn;
	/** The last turn — the one that has seen every tool result, so the interesting one. */
	lastTurn(): RecordedTurn;
	/** The text of each tool result in a turn, in order. */
	results(turn: RecordedTurn): string[];
	/** The whole of a turn's text, for a coarse "is this string anywhere" check. */
	flat(turn: RecordedTurn): string;
	/** The session JSONL: what pi recorded, which the filter must never touch. */
	sessionText(): string;
	/**
	 * Every `toolCall` in every turn is answered by a `toolResult` with the same
	 * id, in the same order. A provider request with an orphaned tool_use is
	 * rejected outright, so this is the invariant a filter that dropped or
	 * reordered a message would break — worth checking in every case rather
	 * than in one.
	 */
	assertWellFormed(): void;
}

export function inspector(dir: string): Inspector {
	const turns = (): RecordedTurn[] => {
		const fauxDir = join(dir, FAUX_DIR);
		if (!existsSync(fauxDir)) return [];
		return readdirSync(fauxDir)
			.filter((f) => f.startsWith("turn-"))
			.map((f) => [Number(f.slice("turn-".length, -".json".length)), f] as const)
			.sort((a, b) => a[0] - b[0])
			.map(([, f]) => JSON.parse(readFileSync(join(fauxDir, f), "utf8")) as RecordedTurn);
	};

	const text = (m: RecordedMessage): string =>
		typeof m.content === "string"
			? m.content
			: m.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");

	const self: Inspector = {
		turns,
		turn(n) {
			const all = turns();
			assert.ok(all.length >= n, `wanted turn ${n}, the faux model was asked ${all.length} times`);
			return all[n - 1];
		},
		lastTurn() {
			const all = turns();
			assert.ok(all.length, "the faux model was never asked for a turn");
			return all[all.length - 1];
		},
		results: (turn) => turn.filter((m) => m.role === "toolResult").map(text),
		flat: (turn) => turn.map(text).join("\n"),
		sessionText() {
			const files = sessionFilesFor(dir);
			assert.ok(files.length, `no session file recorded for ${dir}`);
			return files.map((f) => readFileSync(f, "utf8")).join("\n");
		},
		assertWellFormed() {
			for (const [i, turn] of turns().entries()) {
				const calls: string[] = [];
				const answers: string[] = [];
				for (const m of turn) {
					if (m.role === "toolResult" && m.toolCallId) answers.push(m.toolCallId);
					if (m.role !== "assistant" || typeof m.content === "string") continue;
					for (const c of m.content) if (c.type === "toolCall" && c.id) calls.push(c.id);
				}
				assert.deepEqual(
					answers,
					calls,
					`turn ${i + 1}: tool calls and their results do not line up.\n` +
						`  calls:   ${calls.join(", ") || "(none)"}\n` +
						`  answers: ${answers.join(", ") || "(none)"}`,
				);
			}
		},
	};
	return self;
}
