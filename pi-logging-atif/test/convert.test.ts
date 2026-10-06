// What each branch shape converts to. Every case also runs the result through
// the ported ATIF checker, so "converts to the right thing" never passes on a
// file Harbor would reject.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Step, Trajectory } from "../src/atif.ts";
import { lastRecordedPrompt, toTrajectory, type ConvertOutput } from "../src/convert.ts";
import { atifErrors } from "./atif-check.ts";
import { SCENARIOS, builder, input, text } from "./scenarios.ts";

function run(name: string): ConvertOutput {
	const out = toTrajectory(SCENARIOS[name]());
	assert.ok(out, `${name} produced no trajectory`);
	assert.deepEqual(atifErrors(out.trajectory), [], `${name} is not valid ATIF`);
	return out;
}

const sources = (t: Trajectory) => t.steps.map((s) => s.source).join(" ");
const pi = (s: Step) => (s.extra?.pi ?? {}) as Record<string, unknown>;

test("every scenario converts to valid ATIF", () => {
	for (const name of Object.keys(SCENARIOS)) run(name);
});

test("nothing to write until a user or agent step exists", () => {
	const b = builder();
	assert.equal(toTrajectory(input([])), undefined);
	assert.equal(toTrajectory(input([b.prompt("p")])), undefined);
	assert.equal(toTrajectory(input([b.prompt("p")], { fallbackSystemPrompt: "q" })), undefined);
	assert.equal(toTrajectory(input([b.thinkingLevel("high"), b.label()])), undefined);
});

test("a plain turn: system, user, agent — with root fields and metrics", () => {
	const { trajectory: t, images } = run("plain-turn");
	assert.equal(t.schema_version, "ATIF-v1.7");
	assert.equal(t.session_id, "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
	assert.equal(t.trajectory_id, t.session_id);
	assert.equal(sources(t), "system user agent");
	assert.deepEqual(t.steps.map((s) => s.step_id), [1, 2, 3]);
	assert.equal(t.steps[0].message, "You are pi.");
	assert.equal(t.steps[1].message, "hello");

	const agent = t.steps[2];
	assert.equal(agent.message, "hi there");
	assert.equal(agent.model_name, "test/model-a");
	assert.equal(agent.llm_call_count, 1);
	assert.equal(agent.timestamp, "2026-10-05T12:00:03.000Z");
	// prompt_tokens is every input token: pi-ai's `input` is the uncached part.
	assert.deepEqual(agent.metrics, {
		prompt_tokens: 80 + 20 + 4,
		completion_tokens: 5,
		cached_tokens: 20,
		cost_usd: 0.0012,
		extra: { cache_write_tokens: 4 },
	});
	assert.deepEqual(pi(agent), { entry_id: "e3", provider: "openrouter", api: "openai-completions", stop_reason: "stop" });

	assert.equal(t.agent.name, "pi");
	assert.equal(t.agent.version, "0.84.2");
	assert.equal(t.agent.model_name, "test/model-a", "falls back to the last assistant's model");
	assert.deepEqual(t.agent.extra, { provider: "openrouter", cwd: "/work/project", producer: "@ocramz/pi-logging-atif@test" });
	assert.deepEqual(t.final_metrics, {
		total_prompt_tokens: 104,
		total_completion_tokens: 5,
		total_cached_tokens: 20,
		total_cost_usd: 0.0012,
		total_steps: 3,
	});
	assert.deepEqual(images, []);
});

test("tool calls and their results land on the same agent step", () => {
	const { trajectory: t } = run("parallel-tool-calls");
	assert.equal(sources(t), "system user agent agent");
	const s = t.steps[2];
	assert.equal(s.message, "Running both.");
	assert.equal(s.reasoning_content, "two things at once");
	assert.deepEqual(s.tool_calls, [
		{ tool_call_id: "c1", function_name: "bash", arguments: { command: "ls" } },
		{ tool_call_id: "c2", function_name: "bash", arguments: { command: "wc -l x" } },
	]);
	assert.deepEqual(s.observation, {
		results: [
			{ source_call_id: "c1", content: "a\nb", extra: { tool_name: "bash", is_error: false } },
			{ source_call_id: "c2", content: "wc: x: No such file", extra: { tool_name: "bash", is_error: true } },
		],
	});
	assert.equal(pi(s).stop_reason, "toolUse");
	assert.equal(t.steps[3].observation, undefined);
});

test("a system step only when the prompt changes", () => {
	const { trajectory: t } = run("prompt-changes");
	assert.equal(sources(t), "system user agent user agent system user agent");
	assert.equal(t.steps[0].message, "prompt A");
	assert.equal(t.steps[5].message, "prompt B");
});

test("thinking level becomes reasoning_effort; a model change is not a step", () => {
	const { trajectory: t } = run("thinking-and-model");
	assert.equal(sources(t), "system user agent user agent");
	assert.equal(t.steps[2].reasoning_effort, "high");
	assert.equal(t.steps[2].reasoning_content, "visible", "redacted thinking is not reasoning anyone can read");
	assert.equal(pi(t.steps[2]).redacted_thinking, true);
	assert.equal(t.steps[4].model_name, "test/model-b");
	assert.equal(t.steps[4].reasoning_effort, "high");
});

test("aborted and failed calls are still steps", () => {
	const { trajectory: t } = run("aborted-and-error");
	assert.equal(sources(t), "system user agent user agent");
	assert.equal(t.steps[2].message, "");
	assert.equal(pi(t.steps[2]).stop_reason, "aborted");
	assert.equal(pi(t.steps[4]).stop_reason, "error");
	assert.equal(pi(t.steps[4]).error_message, "429 rate limited");
});

test("a compaction replaces context, then re-includes the kept tail as copies", () => {
	const { trajectory: t } = run("compaction");
	assert.equal(sources(t), "system user agent agent user agent system user agent user agent");

	const boundary = t.steps[6];
	assert.equal(boundary.message, "Context compaction performed");
	assert.deepEqual(boundary.observation, { results: [{ content: "Summary: the user asked two questions." }] });
	assert.deepEqual(boundary.extra?.context_management, { type: "compaction", boundary: "replace" });
	assert.equal(pi(boundary).tokens_before, 50_000);

	// pi keeps the tail from firstKeptEntryId (buildContextEntries); those are
	// the steps after the boundary that are copies, not new behaviour.
	const [copyUser, copyAgent] = [t.steps[7], t.steps[8]];
	assert.equal(copyUser.message, "second question");
	assert.equal(copyUser.is_copied_context, true);
	assert.equal(copyAgent.message, "second answer");
	assert.equal(copyAgent.is_copied_context, true);
	assert.equal(copyAgent.metrics, undefined, "a copy spent no tokens");
	assert.equal(pi(copyAgent).entry_id, pi(t.steps[5]).entry_id, "a copy names the entry it came from");
	assert.equal(t.steps[9].is_copied_context, undefined);

	// Copies excluded from the totals; the summary call reported beside them.
	assert.equal(t.final_metrics?.total_prompt_tokens, 100 + 120 + 140 + 60);
	assert.deepEqual(t.final_metrics?.extra, {
		auxiliary: { prompt_tokens: 500, completion_tokens: 50, cached_tokens: 0, cost_usd: 0.01 },
	});
});

test("a kept compaction is copied as an injected summary, not a second reset", () => {
	const { trajectory: t } = run("two-compactions");
	const resets = t.steps.filter((s) => (s.extra?.context_management as { boundary?: string })?.boundary === "replace");
	assert.equal(resets.length, 2);
	assert.ok(resets.every((s) => !s.is_copied_context));

	const copiedSummary = t.steps.find((s) => s.is_copied_context && s.message === "Context compaction performed");
	assert.ok(copiedSummary, "the first compaction is inside the second's kept range");
	assert.deepEqual(copiedSummary.extra?.context_management, { type: "injection", boundary: "append" });

	// After the second boundary: copies of q2 a2 <compaction one> q3 a3, then q4 a4.
	const second = t.steps.indexOf(resets[1]);
	const after = t.steps.slice(second + 1).map((s) => `${s.is_copied_context ? "*" : ""}${typeof s.message === "string" ? s.message : "?"}`);
	assert.deepEqual(after, ["*q2", "*a2", "*Context compaction performed", "*q3", "*a3", "q4", "a4"]);
});

test("injected context becomes system injection steps", () => {
	const { trajectory: t } = run("injections");
	assert.equal(sources(t), "system system user system system agent");
	for (const i of [1, 3, 4]) {
		assert.deepEqual(t.steps[i].extra?.context_management, { type: "injection", boundary: "append" });
	}
	assert.equal(t.steps[1].message, "Earlier, on another branch, the user tried X.");
	assert.equal(pi(t.steps[3]).custom_type, "issue-tracker-context");
	assert.equal(pi(t.steps[4]).custom_type, "lean-autoprove");
	assert.equal(t.steps[4].message, "Autoprove is on.");
});

test("a user's !command is a user step; !!command never reached the model", () => {
	const { trajectory: t } = run("user-bash");
	assert.equal(sources(t), "system user user agent");
	assert.equal(t.steps[1].message, "!git status");
	assert.deepEqual(t.steps[1].observation, { results: [{ content: "nothing to commit" }] });
	assert.equal(pi(t.steps[1]).exit_code, 0);
	assert.ok(!JSON.stringify(t).includes("hunter2"));
});

test("images are referenced by content-addressed path, and unsupported types are named", () => {
	const { trajectory: t, images } = run("images");
	const user = t.steps[1].message;
	assert.ok(Array.isArray(user));
	assert.equal(user.length, 4);
	assert.deepEqual(user[0], { type: "text", text: "what is this?" });
	assert.equal(user[1].type, "image");
	assert.deepEqual(user[1], user[2], "the same bytes, the same file");
	assert.match(JSON.stringify(user[1]), /"path":"trajectory\.atif\.images\/[0-9a-f]{16}\.png"/);
	assert.deepEqual(user[3], { type: "text", text: "[image omitted: image/bmp is not a type ATIF accepts]" });

	const result = t.steps[2].observation?.results[0].content;
	assert.ok(Array.isArray(result));
	assert.equal(result[1].type, "image");

	assert.equal(images.length, 2, "one file per distinct image");
	assert.ok(images.every((i) => i.path.startsWith("trajectory.atif.images/")));
});

test("a tool result with no matching call keeps its id out of source_call_id", () => {
	const { trajectory: t } = run("orphan-tool-result");
	assert.equal(sources(t), "system system user agent");

	// Before any agent step: nothing to attach to, so a system step of its own.
	assert.equal(t.steps[1].message, "Tool result for bash");
	assert.deepEqual(t.steps[1].observation, {
		results: [{ content: "before any call", extra: { tool_name: "bash", is_error: false, tool_call_id: "c0" } }],
	});

	// Inside a turn: on the turn's agent step, unpinned, and without disturbing
	// the result that does match.
	assert.deepEqual(t.steps[3].observation, {
		results: [
			{ content: "from nowhere", extra: { tool_name: "bash", is_error: false, tool_call_id: "c-unknown" } },
			{ source_call_id: "c1", content: "ok", extra: { tool_name: "bash", is_error: false } },
		],
	});
});

test("the fallback prompt is used only when none was recorded, and says so", () => {
	const { trajectory: t } = run("fallback-prompt");
	assert.equal(sources(t), "system user agent");
	assert.equal(t.steps[0].message, "The prompt as of now.");
	assert.deepEqual(t.steps[0].extra, { pi: { system_prompt: "current" } });

	const recorded = toTrajectory({ ...SCENARIOS["plain-turn"](), fallbackSystemPrompt: "ignored" });
	assert.equal(recorded?.trajectory.steps[0].message, "You are pi.");
});

test("pi 0.86+ system messages count as recorded prompts", () => {
	const { trajectory: t } = run("system-messages");
	assert.equal(sources(t), "system user agent", "the same prompt twice is one step");
});

test("active tools become OpenAI-shaped tool_definitions", () => {
	const { trajectory: t } = run("tool-definitions");
	assert.equal(t.agent.model_name, "test/model-current", "the session's model wins over the last step's");
	assert.deepEqual(t.agent.tool_definitions, [
		{
			type: "function",
			function: {
				name: "bash",
				description: "Run a shell command.",
				parameters: {
					type: "object",
					properties: { command: { type: "string", description: "The command." } },
					required: ["command"],
				},
			},
		},
		{ type: "function", function: { name: "noop" } },
	]);
});

test("a tool's own LLM spend is auxiliary, not a step's", () => {
	const { trajectory: t } = run("tool-usage");
	assert.equal(t.final_metrics?.total_cost_usd, 0.001 + 0.002);
	assert.deepEqual(t.final_metrics?.extra, {
		auxiliary: { prompt_tokens: 1000, completion_tokens: 100, cached_tokens: 0, cost_usd: 0.02 },
	});
});

test("lastRecordedPrompt reads the latest recorded prompt", () => {
	const b = builder();
	assert.equal(lastRecordedPrompt([]), undefined);
	assert.equal(lastRecordedPrompt([b.user("x")]), undefined);
	assert.equal(lastRecordedPrompt([b.prompt("one"), b.user("x"), b.prompt("two"), b.assistant([text("y")])]), "two");
	assert.equal(lastRecordedPrompt([b.prompt("one"), b.systemMessage("three")]), "three");
});
