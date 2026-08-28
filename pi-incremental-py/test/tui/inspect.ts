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

/**
 * The tool-result text out of a provider payload, in wire order.
 *
 * `before_provider_request` carries `payload: unknown` — the provider's own wire
 * shape, not pi's `AgentMessage`, so there is nothing to narrow it with but a
 * shape check. Two shapes are handled: OpenAI/OpenRouter chat-completions, where
 * a result is a `role: "tool"` message, and Anthropic messages, where it is a
 * `tool_result` block inside a user message. Anything else yields nothing.
 *
 * That last sentence is the hazard: an empty result makes every
 * `assert.doesNotMatch` against it pass, so a wire-format change would turn a
 * negative assertion into a no-op that reads green. Callers must assert the
 * array is non-empty before asserting anything about its contents.
 */
export function payloadToolResults(payload: unknown): string[] {
	const messages = (payload as { messages?: unknown })?.messages;
	if (!Array.isArray(messages)) return [];

	const out: string[] = [];
	for (const m of messages as { role?: unknown; content?: unknown }[]) {
		// OpenAI/OpenRouter: the result is the whole message.
		if (m?.role === "tool") {
			out.push(blockText(m.content));
			continue;
		}
		// Anthropic: the results ride inside the next user message.
		if (m?.role === "user" && Array.isArray(m.content)) {
			for (const c of m.content as { type?: unknown; content?: unknown }[]) {
				if (c?.type === "tool_result") out.push(blockText(c.content));
			}
		}
	}
	return out;
}

/** One tool call out of the logger's JSONL, joined to the result it got back. */
export interface LoggedToolCall {
	id: string;
	tool: string;
	input: unknown;
	/**
	 * Absent while the call is still in flight — a live case that closed the
	 * session mid-turn has one of these, and it is not a failure by itself.
	 */
	result?: { isError?: boolean; content?: unknown; details?: unknown };
}

/**
 * Every logged tool call, in call order, each carrying its own result.
 *
 * The logger writes `tool_call` and `tool_result` as separate lines joined only
 * by an id, which is one join too many to do inline in an assertion. This is
 * the counterpart of `payloadToolResults` for the other record the logger
 * keeps: that one is what the *provider* was sent, this one is what the
 * extension actually did — including `details`, which never goes on the wire.
 */
export function loggedToolCalls(events: LoggedEvent[]): LoggedToolCall[] {
	const calls: LoggedToolCall[] = [];
	const byId = new Map<string, LoggedToolCall>();
	for (const e of events) {
		if (typeof e.id !== "string") continue;
		if (e.event === "tool_call") {
			const call: LoggedToolCall = { id: e.id, tool: String(e.tool), input: e.input };
			calls.push(call);
			byId.set(call.id, call);
		} else if (e.event === "tool_result") {
			const call = byId.get(e.id);
			if (call) {
				call.result = {
					isError: e.isError === true,
					content: e.content,
					details: e.details,
				};
			}
		}
	}
	return calls;
}

/** What `waitForLog` needs of a session. Keeps it usable from any case. */
interface Logged {
	logEvents(): LoggedEvent[];
	logPath(): string;
}

/**
 * Poll the log until `ready` accepts the tool traffic recorded so far.
 *
 * The wait a live case wants, rather than one on the screen. What pi prints of
 * a turn is the model's paraphrase of it — good evidence that *something*
 * happened and none at all of what — so a case that waits for a phrase is
 * really waiting for a model to choose a wording. The log moves when the
 * extension moves.
 *
 * `ready` takes the whole call list rather than one call because the thing a
 * case is waiting for is usually an outcome ("the kernel holds x") that no
 * single call is guaranteed to be the one to report.
 *
 * On timeout it names the tools that *were* called, which is the question you
 * ask next anyway when a live case fails.
 */
export async function waitForLog(
	s: Logged,
	what: string,
	ready: (calls: LoggedToolCall[]) => boolean,
	timeout = 300_000,
): Promise<void> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const calls = loggedToolCalls(s.logEvents());
		if (ready(calls)) return;
		if (Date.now() >= deadline) {
			assert.fail(
				`${what} did not happen within ${timeout}ms.\n` +
					`  tools called: ${calls.map((c) => c.tool).join(", ") || "(none)"}\n` +
					`  log: ${s.logPath()}`,
			);
		}
		await new Promise((done) => setTimeout(done, 500));
	}
}

/** A wire `content`: a bare string, or blocks of which only the text ones count. */
function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as { type?: unknown; text?: unknown }[])
		.map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
		.join("");
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
