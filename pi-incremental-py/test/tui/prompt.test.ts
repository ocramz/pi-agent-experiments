// What the model is *told*, as against what it is shown (context.test.ts) and
// what the human sees (commands.test.ts).
//
// Three tools, three long descriptions, nine promptGuidelines and a typebox
// schema per tool — all of it addressed to a model, none of it reachable from
// any other tier. It appears in no message, so the transcript cannot show it;
// `before_provider_request`, which carries the wire payload, never fires here
// because pi-ai's faux provider does not call `onPayload`. What does reach this
// tier is the whole `Context`, and its `systemPrompt` and `tools` are exactly
// the two halves of the answer. test/tui/faux-model.ts records them; inspect.ts
// hands them over.
//
// A one-step script is enough: the prompt is fully assembled before the first
// call, so nothing needs to have happened yet. Free, deterministic, no key.
//
// P5 is the odd one out — it checks that shared/dev/pi-logger.ts is wired up
// rather than checking a prompt. It lives here because the logger's subject is
// the same one: the inputs the model was given, as against what it did with
// them.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { session, type Session } from "./session.ts";

/** The faux model's closing line. Distinctive so `expect` cannot match an echo. */
const DONE = "SCRIPT-COMPLETE";

const SNAPSHOT = join(import.meta.dirname, "__snapshots__", "agent-prompt.txt");

/** Start a session that does nothing but let pi assemble a prompt, and end it. */
async function prompted(t: TestContext): Promise<Session> {
	const s = await session(t, { faux: [{ text: DONE }] });
	await s.command("go");
	await s.expect(DONE, { timeout: 120_000 });
	await s.close();
	return s;
}

test("P1: every tool reaches the Available tools section", async (t) => {
	const s = await prompted(t);
	const prompt = s.systemPrompt();

	// pi lists a custom tool there only if the registration set `promptSnippet`.
	// Without one the schema is still sent and the line is silently omitted, so
	// a model that never reaches for py_cell looks like a model that dislikes
	// it rather than one that was never told it exists. Nothing else in the
	// repo would notice.
	for (const [name, snippet] of [
		["py_cell", "run Python in a persistent incremental namespace"],
		["py_kernel", "inspect, rerun, run_all, delete, plan or batch-apply cells"],
		["py_install", "pip-install packages with dependency-tracked re-runs"],
	]) {
		assert.match(
			prompt,
			new RegExp(`^- ${name}: .*${escape(snippet)}`, "m"),
			`${name} has no Available-tools line. Its promptSnippet is missing or changed.\n\n${available(prompt)}`,
		);
		// pi renders the line as `- ${name}: ${promptSnippet}` itself, so a
		// snippet that opens by naming its own tool stutters — `- py_cell:
		// py_cell: run Python…`, which is how all three shipped until the
		// snapshot below made it visible.
		assert.doesNotMatch(
			prompt,
			new RegExp(`^- ${name}: ${name}\\b`, "m"),
			`${name}'s promptSnippet repeats the name pi has already printed.\n\n${available(prompt)}`,
		);
	}
});

test("P2: the guidelines the tools registered are the guidelines sent", async (t) => {
	const s = await prompted(t);
	const bullets = ourGuidelines(s.systemPrompt());

	// This count carries the whole attribution invariant, so it is worth being
	// clear about how. `OURS` finds a guideline by the tool it names, and pi
	// gives the model no other way to tell whose guideline is whose — so a
	// guideline that named no tool would simply not be found, and the count
	// would read 9-of-10 and fail here. One that did name a tool reads 10 and
	// also fails, until someone bumps this constant on purpose. Either way an
	// unattributed guideline cannot reach the model quietly, which is exactly
	// what happened to "plan before a multi-cell refactor" for as long as
	// nothing rendered the prompt.
	assert.equal(
		bullets.length,
		9,
		`expected 9 extension guidelines (6 on py_cell, 3 on py_kernel), got ${bullets.length}.\n` +
			"A guideline that names none of the py_* tools is invisible to this filter — and to the model.\n" +
			bullets.join("\n"),
	);

	const all = bullets.join("\n");
	// One anchor per guideline that carries a rule the model can get wrong, in
	// the wording that makes the rule a rule. Short fragments on purpose:
	// the point is that the instruction survived, not that nobody may reword it.
	for (const anchor of [
		"never served from cache", // volatile, and what declaring it buys
		"Do NOT set it for file reads or imports", // ...and what it costs
		"except NameError", // the accumulator idiom
		"ADVANCES it", // rerun on a stateful cell is not a refresh
		"never pip/uv from bash", // py_install over the bash escape hatch
		"stay pending (not poisoned)", // a failed cell is recoverable
		// The three py_kernel ops, spelled as the calls they are. Bare, they read
		// as English — "plan before a multi-cell refactor" is indistinguishable
		// from advice to think ahead, and a model treats it as such.
		'`py_kernel {op: "inspect"}` to orient',
		'`py_kernel {op: "run_all"}` is the recovery move',
		'Call `py_kernel {op: "plan"}` before a multi-cell refactor',
	]) {
		assert.ok(all.includes(anchor), `no guideline mentions ${JSON.stringify(anchor)}:\n${all}`);
	}
});

test("P3: the schema carries the parameter documentation, not just the types", async (t) => {
	const s = await prompted(t);
	const props = s.tool("py_cell").parameters?.properties ?? {};

	// `volatile` is a declared fact about the cell that only the caller knows,
	// so the description is the whole of the interface: a boolean named
	// "volatile" with no prose tells a model nothing about when to pass it.
	// This is the assertion that would have caught shipping the flag with its
	// description dropped — the schema would still be valid and every other
	// tier still green.
	assert.ok(props.volatile, `py_cell has no volatile parameter. Sent: ${Object.keys(props).join(", ")}`);
	assert.equal(props.volatile.type, "boolean");
	assert.match(props.volatile.description ?? "", /clock|RNG|network/);
	assert.match(props.volatile.description ?? "", /never be served from cache/);

	assert.match(props.id?.description ?? "", /Omit to create/);
	assert.match(props.run?.description ?? "", /default true/);
	assert.deepEqual(s.tool("py_cell").parameters?.required, ["src"]);

	// The description is the tool's whole case for itself against `bash python`.
	assert.match(s.tool("py_cell").description ?? "", /Prefer this over running python in bash/);
	assert.match(s.tool("py_install").description ?? "", /instead of running pip or uv in bash/);
});

test("P4: the prompt this extension contributes matches the snapshot", async (t) => {
	const s = await prompted(t);
	const slice = extensionSlice(s.systemPrompt());

	// Only this extension's own lines. pi's boilerplate is pinned in
	// shared/versions.env and is not this package's to snapshot: including it
	// would turn every pi bump into a diff nobody asked for, and bury the one
	// line that did change under forty that did not.
	if (process.env.PI_UPDATE_PROMPT) {
		mkdirSync(join(import.meta.dirname, "__snapshots__"), { recursive: true });
		writeFileSync(SNAPSHOT, slice, "utf8");
		return;
	}
	assert.ok(
		existsSync(SNAPSHOT),
		`no snapshot at ${SNAPSHOT}. Create it with PI_UPDATE_PROMPT=1 node --test test/tui/prompt.test.ts`,
	);
	assert.equal(
		slice,
		readFileSync(SNAPSHOT, "utf8"),
		"the agent-facing prompt changed. If that was the intention, re-record it with\n" +
			"  PI_UPDATE_PROMPT=1 node --test test/tui/prompt.test.ts\n" +
			"and put the regenerated snapshot in the diff, where it can be read.",
	);
});

test("P5: the prompt logger records a session it is loaded into", async (t) => {
	// Wiring only, but wiring worth a free case: the logger is the sole
	// diagnostic the live tier has, and L3 now asserts on what it wrote. Left to
	// live.test.ts, a broken `-e` path or a mis-set PI_PY_LOG_DIR would first
	// show up as a paid run failing for a reason that looks like the extension.
	const s = await session(t, {
		log: true,
		faux: [{ tool: "py_cell", args: { src: "total = 1\ntotal" } }, { text: DONE }],
	});
	await s.command("go");
	await s.expect(DONE, { timeout: 120_000 });
	await s.close();

	const events = s.logEvents();
	assert.ok(events.length, `the logger wrote nothing under ${s.logPath()}`);
	const seen = new Set(events.map((e) => e.event));
	for (const event of ["session_start", "tools", "prompt", "context", "tool_call", "tool_result"]) {
		assert.ok(seen.has(event), `no ${event} in the log. Recorded: ${[...seen].join(", ")}`);
	}
	// `payload` is deliberately absent: pi-ai's faux provider does not call
	// `onPayload`, so `before_provider_request` cannot fire here. That is the
	// whole reason the deterministic tier reads `Context` and the live tier
	// reads the log.
	assert.ok(!seen.has("payload"), "the faux provider is not supposed to produce a wire payload");

	// The structured record of what the model was told, which is what makes the
	// log worth keeping over a screen dump: toolSnippets names each tool that
	// earned an Available-tools line, without anyone having to parse the prompt.
	const prompt = events.find((e) => e.event === "prompt");
	const options = prompt?.systemPromptOptions as { toolSnippets?: Record<string, string> };
	assert.ok(options?.toolSnippets?.py_cell, "py_cell contributed no toolSnippet");

	// The filter runs before the logger's `context` handler, so these counts are
	// the size of what the model was handed, not of the transcript.
	const sizes = events.filter((e) => e.event === "context").map((e) => e.bytes as number);
	assert.ok(sizes.length >= 2, `expected a context record per call, got ${sizes.length}`);
	assert.ok(sizes.every((b) => b > 0));
});

/**
 * The extension's contribution to the system prompt, in prompt order.
 *
 * pi flattens every tool's `promptGuidelines` into one list alongside its own,
 * with nothing marking whose is whose, so this filters on the tool each one
 * names. P2 asserts the resulting count, which is what keeps the filter honest.
 */
function extensionSlice(prompt: string): string {
	const tools = lines(prompt).filter((l) => /^- py_\w+: /.test(l));
	return [...tools, "", ...ourGuidelines(prompt)].join("\n") + "\n";
}

/**
 * How a guideline of ours is told apart from one of pi's: it names a py_* tool.
 *
 * Exact rather than heuristic, and only because the guidelines were written to
 * make it so — pi's own never mention one. P2's count assertion is what holds
 * that property in place.
 */
const OURS = /\bpy_(cell|kernel|install)\b/;

function ourGuidelines(prompt: string): string[] {
	const guidelines = prompt.slice(prompt.indexOf("\nGuidelines:\n"));
	return lines(guidelines).filter((l) => l.startsWith("- ") && OURS.test(l));
}

const lines = (s: string): string[] => s.split("\n").map((l) => l.trimEnd());

/** The Available tools section, for a failure message worth reading. */
function available(prompt: string): string {
	const start = prompt.indexOf("Available tools:");
	return start < 0 ? prompt.slice(0, 500) : prompt.slice(start, prompt.indexOf("\n\n", start));
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
