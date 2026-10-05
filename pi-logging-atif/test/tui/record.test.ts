// The extension inside a real pi, driven by the faux model.
//
// The unit tier proves what a branch converts to. Only this tier proves the
// wiring: that agent_start records the prompt the provider actually received,
// that agent_end writes while the session is still running, that the real
// `getBranch()` converts to valid ATIF, and that "off" really is off. Free and
// deterministic — no network, no key.
//
// Assertions on files run after `close()`: pi persists the session file and
// the extension rewrites the trajectory on the way out.

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Step } from "../../src/atif.ts";
import { atifErrors } from "../atif-check.ts";
import { ATIF_DIR, session } from "./session.ts";

/** Closing lines. Distinctive so `expect` cannot match an echo of the prompt. */
const DONE_1 = "FIRST-ANSWER-COMPLETE";
const DONE_2 = "SECOND-ANSWER-COMPLETE";
const PROBE = "atif-probe-output";

const sources = (steps: Step[]) => steps.map((s) => s.source).join(" ");

async function eventually(check: () => boolean, what: string, timeout = 15_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!check()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

test("R1: a recorded session — the prompt the provider saw, a tool call, its observation", async (t) => {
	const s = await session(t, {
		record: true,
		faux: [
			{ tool: "bash", args: { command: `echo ${PROBE}` } },
			{ text: DONE_1, thinking: "the command printed the probe" },
			{ text: DONE_2 },
		],
	});

	await s.command("run the probe");
	await s.expect(DONE_1, { timeout: 60_000 });
	// Written at agent_end, while pi is still running — not only on the way out.
	await eventually(
		() => s.atifFiles().length === 1 && s.trajectory(join(ATIF_DIR, s.atifFiles()[0])).steps.length === 4,
		"the trajectory to be written after the first prompt",
	);

	await s.command("and again");
	await s.expect(DONE_2, { timeout: 60_000 });
	await s.close();

	const files = s.atifFiles();
	assert.equal(files.length, 1, "one file per session");
	const t1 = s.trajectory(join(ATIF_DIR, files[0]));
	assert.deepEqual(atifErrors(t1, join(s.dir, ATIF_DIR)), []);

	assert.equal(sources(t1.steps), "system user agent agent user agent");
	assert.equal(t1.steps[0].message, s.providerPrompt(1), "the system step is what the provider was handed");
	assert.equal(s.providerPrompt(3), s.providerPrompt(1), "and it did not change, so one system step is right");
	assert.equal(t1.steps[1].message, "run the probe");

	const acting = t1.steps[2];
	assert.equal(acting.tool_calls?.length, 1);
	const [call] = acting.tool_calls!;
	assert.equal(call.function_name, "bash");
	assert.deepEqual(call.arguments, { command: `echo ${PROBE}` });
	const [result] = acting.observation?.results ?? [];
	assert.equal(result?.source_call_id, call.tool_call_id);
	assert.match(String(result?.content), new RegExp(PROBE));

	assert.equal(t1.steps[3].message, DONE_1);
	assert.equal(t1.steps[3].reasoning_content, "the command printed the probe");
	assert.equal(t1.steps[5].message, DONE_2);
	for (const i of [2, 3, 5]) {
		assert.equal(t1.steps[i].model_name, "faux");
		assert.ok((t1.steps[i].metrics?.prompt_tokens ?? 0) > 0, `step ${i + 1} has token counts`);
	}

	const entries = s.sessionEntries();
	const header = entries.find((e) => e.type === "session") as { id: string } | undefined;
	assert.equal(t1.session_id, header?.id);
	assert.equal(t1.agent.model_name, "faux");
	assert.ok(t1.agent.tool_definitions?.some((d) => d.function.name === "bash"));
	assert.equal(t1.final_metrics?.total_steps, 6);

	// Recorded once, though agent_start ran twice: the prompt did not change.
	assert.equal(entries.filter((e) => e.type === "custom" && e.customType === "atif-system-prompt").length, 1);
});

test("R2: off unless configured — and /atif-export still works on demand", async (t) => {
	const s = await session(t, { faux: [{ text: DONE_1 }] });

	await s.command("/atif-export");
	await s.expect("Usage: /atif-export");

	await s.command("hello");
	await s.expect(DONE_1, { timeout: 60_000 });
	await s.command("/atif-export out/trajectory.json");
	await s.expect("ATIF trajectory written");
	await s.close();

	assert.deepEqual(s.atifFiles(), [], "nothing written automatically");
	const entries = s.sessionEntries();
	assert.ok(
		!entries.some((e) => e.type === "custom" && e.customType === "atif-system-prompt"),
		"nothing added to the session either",
	);

	const t1 = s.trajectory("out/trajectory.json");
	assert.deepEqual(atifErrors(t1, join(s.dir, "out")), []);
	assert.equal(sources(t1.steps), "system user agent");
	// No prompt was recorded, so the export used the prompt as of the export —
	// the same one here, and the step says which kind it is.
	assert.equal(t1.steps[0].message, s.providerPrompt(1));
	assert.deepEqual(t1.steps[0].extra, { pi: { system_prompt: "current" } });
});
