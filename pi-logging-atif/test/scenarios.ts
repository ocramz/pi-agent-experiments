// Session branches built by hand, one per shape the converter has to handle.
//
// Shared by two consumers: convert.test.ts asserts what each one converts to,
// and test/container/emit-scenarios.ts writes every one of them out for Harbor's
// own validator. The second is the point of keeping them in one table — the
// unit tier's checker is a port, and the scenarios are what keep the port and
// the original agreeing.
//
// Entries are shaped like pi's session entries but built from scratch, with no
// pi involved; extensions/index.ts passing the real `getBranch()` into the same
// function is what `npm run typecheck` checks.

import { SYSTEM_PROMPT_ENTRY, type BranchEntry, type ConvertInput, type PiMessage, type Usage } from "../src/convert.ts";

/** 1×1 PNGs, distinct so they content-address to different files. */
export const PNG_A =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
export const PNG_B =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const HEADER = {
	id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
	timestamp: "2026-10-05T12:00:00.000Z",
	cwd: "/work/project",
};

/** The input every scenario shares; a scenario overrides what it is about. */
export function input(branch: BranchEntry[], overrides: Partial<ConvertInput> = {}): ConvertInput {
	return {
		header: HEADER,
		branch,
		agentVersion: "0.84.2",
		producer: "@ocramz/pi-logging-atif@test",
		imageDir: "trajectory.atif.images",
		...overrides,
	};
}

/** Builds entries with sequential ids and one-second-apart timestamps. */
export function builder() {
	let n = 0;
	const at = (): { id: string; timestamp: string; ms: number } => {
		n++;
		const ms = Date.UTC(2026, 9, 5, 12, 0, n);
		return { id: `e${n}`, timestamp: new Date(ms).toISOString(), ms };
	};
	const message = (make: (ms: number) => PiMessage): BranchEntry => {
		const { id, timestamp, ms } = at();
		return { id, timestamp, type: "message", message: make(ms) };
	};

	return {
		prompt(text: string): BranchEntry {
			const { id, timestamp } = at();
			return { id, timestamp, type: "custom", customType: SYSTEM_PROMPT_ENTRY, data: { text } };
		},
		user(content: Extract<PiMessage, { role: "user" }>["content"]): BranchEntry {
			return message((timestamp) => ({ role: "user", content, timestamp }));
		},
		assistant(
			content: Extract<PiMessage, { role: "assistant" }>["content"],
			opts: { usage?: Usage; stopReason?: string; errorMessage?: string; model?: string } = {},
		): BranchEntry {
			return message((timestamp) => ({
				role: "assistant",
				content,
				api: "openai-completions",
				provider: "openrouter",
				model: opts.model ?? "test/model-a",
				usage: opts.usage ?? usage(100, 10),
				stopReason: opts.stopReason ?? (content.some((b) => b.type === "toolCall") ? "toolUse" : "stop"),
				...(opts.errorMessage !== undefined && { errorMessage: opts.errorMessage }),
				timestamp,
			}));
		},
		toolResult(
			toolCallId: string,
			toolName: string,
			content: Extract<PiMessage, { role: "toolResult" }>["content"],
			opts: { isError?: boolean; usage?: Usage } = {},
		): BranchEntry {
			return message((timestamp) => ({
				role: "toolResult",
				toolCallId,
				toolName,
				content,
				isError: opts.isError ?? false,
				...(opts.usage && { usage: opts.usage }),
				timestamp,
			}));
		},
		bash(command: string, output: string, opts: { exitCode?: number; excluded?: boolean } = {}): BranchEntry {
			return message((timestamp) => ({
				role: "bashExecution",
				command,
				output,
				exitCode: opts.exitCode ?? 0,
				cancelled: false,
				truncated: false,
				...(opts.excluded && { excludeFromContext: true }),
				timestamp,
			}));
		},
		customMessage(customType: string, text: string): BranchEntry {
			return message((timestamp) => ({ role: "custom", customType, content: text, timestamp }));
		},
		systemMessage(text: string): BranchEntry {
			return message((timestamp) => ({ role: "system", content: text, timestamp }));
		},
		customMessageEntry(customType: string, text: string): BranchEntry {
			const { id, timestamp } = at();
			return { id, timestamp, type: "custom_message", customType, content: text };
		},
		thinkingLevel(level: string): BranchEntry {
			const { id, timestamp } = at();
			return { id, timestamp, type: "thinking_level_change", thinkingLevel: level };
		},
		modelChange(modelId: string): BranchEntry {
			const { id, timestamp } = at();
			return { id, timestamp, type: "model_change", provider: "openrouter", modelId };
		},
		compaction(firstKeptEntryId: string, summary: string, usage?: Usage): BranchEntry {
			const { id, timestamp } = at();
			return { id, timestamp, type: "compaction", summary, firstKeptEntryId, tokensBefore: 50_000, ...(usage && { usage }) };
		},
		branchSummary(summary: string): BranchEntry {
			const { id, timestamp } = at();
			return { id, timestamp, type: "branch_summary", summary };
		},
		label(): BranchEntry {
			const { id, timestamp } = at();
			return { id, timestamp, type: "label" };
		},
	};
}

export function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0): Usage {
	return { input, output, cacheRead, cacheWrite, cost: { total: cost } };
}

export const text = (t: string) => ({ type: "text" as const, text: t });
export const call = (id: string, name: string, args: Record<string, unknown>) =>
	({ type: "toolCall" as const, id, name, arguments: args });
export const thinking = (t: string, redacted = false) => ({ type: "thinking" as const, thinking: t, redacted });
export const image = (data: string, mimeType = "image/png") => ({ type: "image" as const, data, mimeType });

/**
 * Every scenario, by name. Each returns a fresh input, so a test may mutate
 * what it gets.
 */
export const SCENARIOS: Record<string, () => ConvertInput> = {
	"plain-turn": () => {
		const b = builder();
		return input([b.prompt("You are pi."), b.user("hello"), b.assistant([text("hi there")], { usage: usage(80, 5, 20, 4, 0.0012) })]);
	},

	"parallel-tool-calls": () => {
		const b = builder();
		return input([
			b.prompt("You are pi."),
			b.user("list and count"),
			b.assistant([thinking("two things at once"), text("Running both."), call("c1", "bash", { command: "ls" }), call("c2", "bash", { command: "wc -l x" })]),
			b.toolResult("c1", "bash", [text("a\nb")]),
			b.toolResult("c2", "bash", [text("wc: x: No such file")], { isError: true }),
			b.assistant([text("Done.")]),
		]);
	},

	"prompt-changes": () => {
		const b = builder();
		return input([
			b.prompt("prompt A"),
			b.user("one"),
			b.assistant([text("1")]),
			b.prompt("prompt A"),
			b.user("two"),
			b.assistant([text("2")]),
			b.prompt("prompt B"),
			b.user("three"),
			b.assistant([text("3")]),
		]);
	},

	"thinking-and-model": () => {
		const b = builder();
		return input([
			b.prompt("You are pi."),
			b.thinkingLevel("high"),
			b.user("think hard"),
			b.assistant([thinking("visible"), thinking("", true), text("ok")]),
			b.modelChange("test/model-b"),
			b.user("again"),
			b.assistant([text("ok b")], { model: "test/model-b" }),
		]);
	},

	"aborted-and-error": () => {
		const b = builder();
		return input([
			b.prompt("You are pi."),
			b.user("go"),
			b.assistant([], { stopReason: "aborted", usage: usage(0, 0) }),
			b.user("go again"),
			b.assistant([], { stopReason: "error", errorMessage: "429 rate limited", usage: usage(0, 0) }),
		]);
	},

	compaction: () => {
		const b = builder();
		const keptUser = b.user("second question");
		return input([
			b.prompt("You are pi."),
			b.user("first question"),
			b.assistant([call("c1", "bash", { command: "ls" })], { usage: usage(100, 10) }),
			b.toolResult("c1", "bash", [text("a")]),
			b.assistant([text("first answer")], { usage: usage(120, 10) }),
			keptUser,
			b.assistant([text("second answer")], { usage: usage(140, 10) }),
			b.compaction(keptUser.id, "Summary: the user asked two questions.", usage(500, 50, 0, 0, 0.01)),
			b.user("third question"),
			b.assistant([text("third answer")], { usage: usage(60, 10) }),
		]);
	},

	"two-compactions": () => {
		const b = builder();
		const u2 = b.user("q2");
		const branch: BranchEntry[] = [
			b.prompt("You are pi."),
			b.user("q1"),
			b.assistant([text("a1")]),
			u2,
			b.assistant([text("a2")]),
		];
		const first = b.compaction(u2.id, "Summary one.");
		branch.push(first, b.user("q3"), b.assistant([text("a3")]));
		// pi chooses the second cut among what the first left in context, so its
		// kept range can start before the first compaction entry and contain it.
		branch.push(b.compaction(u2.id, "Summary two."), b.user("q4"), b.assistant([text("a4")]));
		return input(branch);
	},

	injections: () => {
		const b = builder();
		return input([
			b.prompt("You are pi."),
			b.branchSummary("Earlier, on another branch, the user tried X."),
			b.user("continue"),
			b.customMessage("issue-tracker-context", "Active story: S-1"),
			b.customMessageEntry("lean-autoprove", "Autoprove is on."),
			b.assistant([text("ok")]),
			b.label(),
		]);
	},

	"user-bash": () => {
		const b = builder();
		return input([
			b.prompt("You are pi."),
			b.bash("git status", "nothing to commit", { exitCode: 0 }),
			b.bash("cat secrets", "hunter2", { excluded: true }),
			b.user("what did that say?"),
			b.assistant([text("Clean tree.")]),
		]);
	},

	images: () => {
		const b = builder();
		return input([
			b.prompt("You are pi."),
			b.user([text("what is this?"), image(PNG_A), image(PNG_A), image("Qk0=", "image/bmp")]),
			b.assistant([call("c1", "screenshot", {})]),
			b.toolResult("c1", "screenshot", [text("captured"), image(PNG_B)]),
			b.assistant([text("A pixel.")]),
		]);
	},

	"orphan-tool-result": () => {
		const b = builder();
		return input([
			b.prompt("You are pi."),
			b.toolResult("c0", "bash", [text("before any call")]),
			b.user("go"),
			b.assistant([call("c1", "bash", { command: "true" })]),
			b.toolResult("c-unknown", "bash", [text("from nowhere")]),
			b.toolResult("c1", "bash", [text("ok")]),
		]);
	},

	"fallback-prompt": () => {
		const b = builder();
		return input([b.user("hello"), b.assistant([text("hi")])], { fallbackSystemPrompt: "The prompt as of now." });
	},

	"system-messages": () => {
		const b = builder();
		return input([b.systemMessage("prompt S"), b.prompt("prompt S"), b.user("hi"), b.assistant([text("yo")])]);
	},

	"tool-definitions": () => {
		const b = builder();
		const schema: Record<string | symbol, unknown> = {
			type: "object",
			properties: { command: { type: "string", description: "The command." } },
			required: ["command"],
			[Symbol.for("TypeBox.Kind")]: "Object",
		};
		return input([b.prompt("You are pi."), b.user("hi"), b.assistant([text("yo")])], {
			model: { id: "test/model-current", provider: "openrouter" },
			tools: [{ name: "bash", description: "Run a shell command.", parameters: schema }, { name: "noop" }],
		});
	},

	"tool-usage": () => {
		const b = builder();
		return input([
			b.prompt("You are pi."),
			b.user("delegate"),
			b.assistant([call("c1", "subagent", { task: "x" })], { usage: usage(100, 10, 0, 0, 0.001) }),
			b.toolResult("c1", "subagent", [text("done")], { usage: usage(1000, 100, 0, 0, 0.02) }),
			b.assistant([text("ok")], { usage: usage(200, 5, 0, 0, 0.002) }),
		]);
	},
};
