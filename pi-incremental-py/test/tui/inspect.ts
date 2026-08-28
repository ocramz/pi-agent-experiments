// What a case asserts on after the pi session ends.
//
// Three records of the same run, which is what makes the filter checkable:
//
//   turn()         the messages pi handed the provider — filtered, one file per call
//   systemPrompt() / tools()
//                  the other two thirds of the same `Context`: the assembled
//                  system prompt and the tool schemas as the model receives them
//   sessionText()  what pi wrote to the session file — unfiltered, always
//
// The filter is supposed to change the first and never the last, so having both
// means non-destructiveness falls out of the same fixture rather than needing a
// case of its own. The middle pair is what the filter must leave alone entirely:
// it rewrites tool results, and a system prompt is not one.
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

/** One tool as the provider was given it: the schema, not the registration. */
export interface RecordedTool {
	name: string;
	description?: string;
	parameters?: {
		properties?: Record<string, { type?: unknown; description?: string }>;
		required?: string[];
	};
}

/** The whole `Context` for one call, as faux-model.ts recorded it. */
export interface RecordedContext {
	systemPrompt?: string;
	tools?: RecordedTool[];
	messages: RecordedTurn;
}

/** Where shared/dev/pi-logger.ts writes, under the fixture. */
export const LOG_DIR = ".pi-log";

/** One line of the logger's JSONL. `event` names which hook produced it. */
export interface LoggedEvent {
	t: number;
	event: string;
	[key: string]: unknown;
}

export interface Inspector {
	/** Every recorded turn's messages, in the order the provider was asked. */
	turns(): RecordedTurn[];
	/** One turn's messages, numbered from 1. */
	turn(n: number): RecordedTurn;
	/** The whole recorded `Context` for one call — prompt, tools and messages. */
	context(n?: number): RecordedContext;
	/**
	 * The system prompt pi assembled for one call, default the first.
	 *
	 * The only place the extension's `promptSnippet` and `promptGuidelines` can
	 * be observed: neither appears in any message, and both are what decides
	 * whether the model reaches for py_cell at all.
	 */
	systemPrompt(n?: number): string;
	/** The tool schemas sent with one call, default the first. */
	tools(n?: number): RecordedTool[];
	/** One tool schema by name. Fails the test if the provider was not given it. */
	tool(name: string, n?: number): RecordedTool;
	/** The last turn — the one that has seen every tool result, so the interesting one. */
	lastTurn(): RecordedTurn;
	/** The text of each tool result in a turn, in order. */
	results(turn: RecordedTurn): string[];
	/** The whole of a turn's text, for a coarse "is this string anywhere" check. */
	flat(turn: RecordedTurn): string;
	/** The session JSONL: what pi recorded, which the filter must never touch. */
	sessionText(): string;
	/**
	 * What shared/dev/pi-logger.ts saw, if the session was started with `log`.
	 *
	 * The only route to the payload a *real* provider was sent: the faux tier
	 * reads `Context` because pi-ai's faux provider never calls `onPayload`, and
	 * a live run has no faux provider to read. Empty when logging was off.
	 */
	logEvents(): LoggedEvent[];
	/** The logger's directory under the fixture, whether or not it has a file. */
	logPath(): string;
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
	const contexts = (): RecordedContext[] => {
		const fauxDir = join(dir, FAUX_DIR);
		if (!existsSync(fauxDir)) return [];
		return readdirSync(fauxDir)
			.filter((f) => f.startsWith("turn-"))
			.map((f) => [Number(f.slice("turn-".length, -".json".length)), f] as const)
			.sort((a, b) => a[0] - b[0])
			.map(([, f]) => JSON.parse(readFileSync(join(fauxDir, f), "utf8")) as RecordedContext);
	};

	// The messages alone, which is what most cases want: a filter case is about
	// what happened to a tool result, and `turn(n)` staying a message array is
	// what kept those cases unchanged when the recorder grew the other two thirds.
	const turns = (): RecordedTurn[] => contexts().map((c) => c.messages);

	const contextAt = (n: number): RecordedContext => {
		const all = contexts();
		assert.ok(all.length >= n, `wanted turn ${n}, the faux model was asked ${all.length} times`);
		return all[n - 1];
	};

	const text = (m: RecordedMessage): string =>
		typeof m.content === "string"
			? m.content
			: m.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");

	const self: Inspector = {
		turns,
		turn: (n) => contextAt(n).messages,
		context: (n = 1) => contextAt(n),
		systemPrompt(n = 1) {
			const prompt = contextAt(n).systemPrompt;
			assert.ok(prompt, `turn ${n} carried no system prompt`);
			return prompt;
		},
		tools: (n = 1) => contextAt(n).tools ?? [],
		tool(name, n = 1) {
			const all = self.tools(n);
			const hit = all.find((t) => t.name === name);
			assert.ok(
				hit,
				`turn ${n} was sent no tool named ${name}. Sent: ${all.map((t) => t.name).join(", ") || "(none)"}`,
			);
			return hit;
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
		logPath: () => join(dir, LOG_DIR),
		logEvents() {
			const logDir = self.logPath();
			if (!existsSync(logDir)) return [];
			// One file per pi process. There is normally exactly one, but reading
			// the directory rather than guessing the name means a fixture that
			// somehow held two sessions reports both instead of half of one.
			return readdirSync(logDir)
				.filter((f) => f.endsWith(".jsonl"))
				.flatMap((f) => readFileSync(join(logDir, f), "utf8").split("\n"))
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line) as LoggedEvent);
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
