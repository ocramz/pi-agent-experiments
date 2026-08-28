// What a case asserts on after the pi session ends.
//
// Two records of the same run:
//
//   context(n)     the whole `Context` pi handed the provider for call n —
//                  systemPrompt, tool schemas, messages
//   sessionText()  what pi wrote to the session file
//
// The first is the only place the extension's promptSnippet, promptGuidelines
// and typebox descriptions can be observed as the model receives them: none of
// it appears in a message.
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
	content: string | { type: string; text?: string; data?: string; mimeType?: string }[];
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

export interface Inspector {
	/** Every recorded call, in order. */
	turns(): RecordedTurn[];
	/** The messages for call `n`, counting from 1. */
	turn(n: number): RecordedTurn;
	/** The whole recorded `Context` for call `n` (default: the last). */
	context(n?: number): RecordedContext;
	/** The assembled system prompt for call `n` (default: the last). */
	systemPrompt(n?: number): string;
	/** The tool schemas for call `n` (default: the last). */
	tools(n?: number): RecordedTool[];
	/** One tool schema by name, asserting it was sent at all. */
	tool(name: string, n?: number): RecordedTool;
	lastTurn(): RecordedTurn;
	/** The text of every tool result in a turn. */
	results(turn: RecordedTurn): string[];
	/** Every content block of every message, flattened — for coarse matching. */
	flat(turn: RecordedTurn): string;
	/** Image blocks across every tool result in a turn. */
	images(turn: RecordedTurn): { mimeType?: string; data?: string }[];
	/** Everything pi wrote to the session file. */
	sessionText(): string;
}

export function inspector(dir: string): Inspector {
	const fauxDir = join(dir, FAUX_DIR);

	function contexts(): RecordedContext[] {
		if (!existsSync(fauxDir)) return [];
		return readdirSync(fauxDir)
			.filter((f) => /^turn-\d+\.json$/.test(f))
			.sort((a, b) => turnNumber(a) - turnNumber(b))
			.map((f) => JSON.parse(readFileSync(join(fauxDir, f), "utf8")) as RecordedContext);
	}

	function at(n?: number): RecordedContext {
		const all = contexts();
		assert.ok(all.length, "no turns were recorded — did the session use { faux: [...] }?");
		const index = n === undefined ? all.length : n;
		assert.ok(index >= 1 && index <= all.length, `turn ${index} of ${all.length} recorded`);
		return all[index - 1];
	}

	const self: Inspector = {
		turns: () => contexts().map((c) => c.messages),
		turn: (n) => at(n).messages,
		context: (n) => at(n),
		systemPrompt: (n) => at(n).systemPrompt ?? "",
		tools: (n) => at(n).tools ?? [],
		tool(name, n) {
			const found = self.tools(n).find((t) => t.name === name);
			assert.ok(
				found,
				`tool ${name} was not sent to the provider. Sent: ${self
					.tools(n)
					.map((t) => t.name)
					.join(", ")}`,
			);
			return found;
		},
		lastTurn: () => self.turn(contexts().length),
		results: (turn) =>
			turn
				.filter((m) => m.role === "toolResult")
				.map((m) => textOf(m)),
		flat: (turn) => turn.map((m) => textOf(m)).join("\n"),
		images: (turn) =>
			turn
				.filter((m) => m.role === "toolResult" && Array.isArray(m.content))
				.flatMap((m) =>
					(m.content as { type: string; data?: string; mimeType?: string }[]).filter(
						(c) => c.type === "image",
					),
				),
		sessionText() {
			const files = sessionFilesFor(dir);
			return files.map((f) => readFileSync(f, "utf8")).join("\n");
		},
	};
	return self;
}

function textOf(m: RecordedMessage): string {
	if (typeof m.content === "string") return m.content;
	return m.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

function turnNumber(file: string): number {
	return Number(file.match(/(\d+)/)![1]);
}
