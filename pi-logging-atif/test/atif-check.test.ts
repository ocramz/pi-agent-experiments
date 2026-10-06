// The checker has to reject things, or every "valid ATIF" assertion in the
// suite passes vacuously. One violation per case, each one a rule the Harbor
// validator enforces.

import assert from "node:assert/strict";
import { test } from "node:test";
import { atifErrors } from "./atif-check.ts";

const valid = () => ({
	schema_version: "ATIF-v1.7",
	agent: { name: "pi", version: "1" },
	steps: [
		{ step_id: 1, source: "user", message: "hi", timestamp: "2026-10-05T12:00:00.000Z" },
		{
			step_id: 2,
			source: "agent",
			message: "",
			tool_calls: [{ tool_call_id: "c1", function_name: "bash", arguments: {} }],
			observation: { results: [{ source_call_id: "c1", content: "ok" }] },
			metrics: { prompt_tokens: 1, completion_tokens: 1, cost_usd: 0 },
		},
	],
});

type T = ReturnType<typeof valid> & Record<string, any>;

function rejects(name: string, mutate: (t: T) => void, pattern: RegExp): void {
	test(`rejects ${name}`, () => {
		const t = valid() as T;
		mutate(t);
		const errors = atifErrors(t);
		assert.ok(errors.some((e) => pattern.test(e)), `expected ${pattern}, got ${JSON.stringify(errors)}`);
	});
}

test("accepts the baseline", () => {
	assert.deepEqual(atifErrors(valid()), []);
});

rejects("an unknown root key", (t) => (t.surprise = 1), /trajectory\.surprise: extra field/);
rejects("an unknown step key", (t) => ((t.steps[0] as any).note = "x"), /steps\[0\]\.note: extra field/);
rejects("an unknown schema version", (t) => (t.schema_version = "ATIF-v2.0"), /schema_version/);
rejects("no steps", (t) => (t.steps = []), /steps: required/);
rejects("a step_id gap", (t) => (t.steps[1].step_id = 3), /steps\[1\]\.step_id: expected 2/);
rejects("an agent-only field on a user step", (t) => ((t.steps[0] as any).metrics = {}), /steps\[0\]\.metrics: agent-only/);
rejects("a dangling source_call_id", (t) => (t.steps[1].observation!.results[0].source_call_id = "c9"), /c9 is not in this step's tool_calls/);
rejects("a non-ISO timestamp", (t) => (t.steps[0].timestamp = "yesterday"), /not ISO 8601/);
rejects("non-dict tool arguments", (t) => ((t.steps[1].tool_calls![0] as any).arguments = "ls"), /arguments: required dict/);
rejects("a fractional token count", (t) => (t.steps[1].metrics!.prompt_tokens = 1.5), /prompt_tokens: int/);
rejects("an image type ATIF does not accept", (t) => {
	t.steps[0].message = [{ type: "image", source: { media_type: "image/bmp", path: "x.bmp" } }] as any;
}, /not an image type ATIF accepts/);
rejects("text on an image part", (t) => {
	t.steps[0].message = [{ type: "image", text: "x", source: { media_type: "image/png", path: "x.png" } }] as any;
}, /text: not allowed when type=image/);
rejects("metrics when llm_call_count is 0", (t) => ((t.steps[1] as any).llm_call_count = 0), /metrics: absent when llm_call_count is 0/);

test("with a base directory, checks that image files exist", () => {
	const t = valid() as T;
	t.steps[0].message = [{ type: "image", source: { media_type: "image/png", path: "missing.png" } }] as any;
	assert.deepEqual(atifErrors(t), []);
	assert.ok(atifErrors(t, "/nonexistent").some((e) => /does not exist: missing\.png/.test(e)));
});
