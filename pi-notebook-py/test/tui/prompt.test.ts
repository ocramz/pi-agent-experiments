// What the model is *told*, as against what the human sees (commands.test.ts).
//
// Four tools, four long descriptions, ten promptGuidelines and a typebox schema
// per tool — all of it addressed to a model, none of it reachable from any
// other tier. It appears in no message, so the transcript cannot show it;
// `before_provider_request`, which carries the wire payload, never fires here
// because pi-ai's faux provider does not call `onPayload`. What does reach this
// tier is the whole `Context`, and its `systemPrompt` and `tools` are exactly
// the two halves of the answer.
//
// A one-step script is enough: the prompt is fully assembled before the first
// call, so nothing needs to have happened yet. Free, deterministic, no key.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
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
	// a model that never reaches for nb_cell looks like a model that dislikes it
	// rather than one that was never told it exists.
	for (const [name, snippet] of [
		["nb_cell", "create or edit a cell in a persistent Python notebook"],
		["nb_run", "run one notebook cell, everything, or everything above or below"],
		["nb_notebook", "list, read, delete, move, restart, save or open the notebook"],
		["nb_install", "pip-install packages into the notebook kernel"],
	]) {
		assert.match(
			prompt,
			new RegExp(`^- ${name}: .*${escape(snippet)}`, "m"),
			`${name} has no Available-tools line. Its promptSnippet is missing or changed.\n\n${available(prompt)}`,
		);
		// pi renders the line as `- ${name}: ${promptSnippet}` itself, so a
		// snippet that opens by naming its own tool stutters.
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

	// This count carries the whole attribution invariant. pi flattens every
	// tool's guidelines into one list with nothing recording whose is whose, so
	// `OURS` finds one by the tool it names — a guideline naming no tool is
	// simply not found, the count reads short, and this fails. Which is the
	// point: an unattributed guideline cannot reach the model quietly.
	assert.equal(
		bullets.length,
		10,
		`expected 10 extension guidelines (5 on nb_cell, 2 on nb_run, 3 on nb_notebook), got ${bullets.length}.\n` +
			"A guideline that names none of the nb_* tools is invisible to this filter — and to the model.\n" +
			bullets.join("\n"),
	);

	// One anchor per guideline that carries a rule the model can get wrong. P2
	// and P4 divide the labour: P4 pins the exact prompt, so any reword is
	// already a deliberate re-record, and P2 only has to say the *rule* survived
	// it. Each anchor is a conjunction matched against one bullet, not against
	// the bullets joined — joined, two guidelines could satisfy an anchor
	// between them.
	const anchors: [string, ...(string | RegExp)[]][] = [
		["small cells, so a re-run is cheap", /nb_cell/, /one coherent step per cell/],
		["the trailing expression is the display value", /nb_cell/, /trailing expression/],
		["what stale means and what to do", /nb_cell/, /stale/, /re-run/],
		["editing discards the old output", /nb_cell/, /discards its previous output/],
		["nb_install over the bash escape hatch", /nb_install/, /pip/, /bash/],
		// The ops, spelled as the calls they are. Bare, they read as English.
		["run all, spelled as the call it is", '`nb_run {op: "all"}`', /restarts/],
		["run below, spelled as the call it is", '`nb_run {op: "below"'],
		["list, spelled as the call it is", '`nb_notebook {op: "list"}`'],
		["save stores no outputs", '`nb_notebook {op: "save"}`', /no outputs/],
		["deleting a cell does not retract its globals", /nb_notebook/, /does NOT remove/],
	];

	for (const [rule, ...needles] of anchors) {
		const hit = bullets.some((b) =>
			needles.every((n) => (typeof n === "string" ? b.includes(n) : n.test(b))),
		);
		assert.ok(hit, `no guideline carries the rule "${rule}":\n${bullets.join("\n")}`);
	}
});

test("P3: the schema carries the parameter documentation, not just the types", async (t) => {
	const s = await prompted(t);
	const cell = s.tool("nb_cell");
	const props = cell.parameters?.properties ?? {};

	// `after` is the only way to insert anywhere but the end, and its two
	// endpoint literals appear nowhere else — a boolean-free string parameter
	// named "after" with no prose tells a model nothing about what to put in it.
	assert.ok(props.after, `nb_cell has no after parameter. Sent: ${Object.keys(props).join(", ")}`);
	assert.match(props.after.description ?? "", /"start"/);
	assert.match(props.after.description ?? "", /"end"/);

	assert.match(props.id?.description ?? "", /Omit to create/);
	assert.match(props.run?.description ?? "", /default true/);
	assert.match(props.kind?.description ?? "", /never executed/);
	assert.deepEqual(cell.parameters?.required, ["src"]);

	// The two ops whose defaults a model would otherwise have to guess.
	const run = s.tool("nb_run").parameters?.properties ?? {};
	assert.match(run.restart?.description ?? "", /default true/);
	const notebook = s.tool("nb_notebook").parameters?.properties ?? {};
	assert.match(notebook.overwrite?.description ?? "", /refused/);

	// Each description is the tool's whole case for itself against `bash python`.
	assert.match(cell.description ?? "", /Prefer this over running python in bash/);
	assert.match(s.tool("nb_install").description ?? "", /instead of pip or uv in bash/);
	// The one thing a user must be told about the file format.
	assert.match(s.tool("nb_notebook").description ?? "", /stores no outputs/);
});

test("P4: the prompt this extension contributes matches the snapshot", async (t) => {
	const s = await prompted(t);
	const slice = extensionSlice(s.systemPrompt());

	// Only this extension's own lines. pi's boilerplate is pinned in
	// shared/versions.env and is not this package's to snapshot: including it
	// would turn every pi bump into a diff nobody asked for.
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

test("P5: a scripted run drives the real tools against a real kernel", async (t) => {
	// The faux tier's other half: no model, but every tool call is real, so this
	// is where the extension's own dispatch — the thing src/ tests cannot reach
	// — is exercised for free.
	const s = await session(t, {
		faux: [
			{ tool: "nb_cell", args: { src: "total = 20" } },
			{ tool: "nb_cell", args: { src: "total + 2" } },
			{ tool: "nb_notebook", args: { op: "list" } },
			{ text: DONE },
		],
	});
	await s.command("go");
	await s.expect(DONE, { timeout: 120_000 });
	await s.close();

	const results = s.results(s.lastTurn());
	assert.ok(
		results.some((r) => r.includes("22")),
		`the second cell's value never reached the model:\n${results.join("\n---\n")}`,
	);
	assert.ok(
		results.some((r) => /2 cells/.test(r)),
		`nb_notebook list did not report two cells:\n${results.join("\n---\n")}`,
	);
});

/**
 * The extension's contribution to the system prompt, in prompt order.
 */
function extensionSlice(prompt: string): string {
	const tools = lines(prompt).filter((l) => /^- nb_\w+: /.test(l));
	return [...tools, "", ...ourGuidelines(prompt)].join("\n") + "\n";
}

/**
 * How a guideline of ours is told apart from one of pi's: it names an nb_* tool.
 *
 * Exact rather than heuristic, and only because the guidelines were written to
 * make it so — pi's own never mention one. P2's count assertion is what holds
 * that property in place.
 */
const OURS = /\bnb_(cell|run|notebook|install)\b/;

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
