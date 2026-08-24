// What the *model* sees, as against what the human sees in commands.test.ts.
//
// The context filter rewrites the extension's own tool results on their way to
// the provider. These cases drive a scripted faux model (test/tui/faux-model.ts)
// which records the messages pi handed it for every call, so each assertion is
// on the real payload rather than on anything a model chose to say about it.
// Real extension, real tools, real Python kernel; no network, no cost.
//
// No key either, and that is checked rather than assumed: the whole file passes
// with OPENROUTER_API_KEY and TAVILY_API_KEY unset. Unlike live.test.ts, these
// cases stay useful on a machine that has no credentials at all.

import assert from "node:assert/strict";
import { test } from "node:test";
import { LAST_ID, nthId, type ScriptStep } from "./faux-script.ts";
import { session } from "./session.ts";

/** The faux model's closing line. Distinctive so `expect` cannot match an echo. */
const DONE = "SCRIPT-COMPLETE";

/** Create a cell, then edit it twice. Three values, only the last one true. */
const editedTwice: ScriptStep[] = [
	{ tool: "py_cell", args: { src: "total = 1\ntotal" } },
	{ tool: "py_cell", args: { id: LAST_ID, src: "total = 2\ntotal" } },
	{ tool: "py_cell", args: { id: LAST_ID, src: "total = 3\ntotal" } },
	{ text: DONE },
];

/** Run a script to completion and hand back the session, ready to inspect. */
async function run(t: Parameters<typeof session>[0], faux: ScriptStep[], env?: NodeJS.ProcessEnv) {
	const s = await session(t, { faux, env });
	await s.command("go");
	await s.expect(DONE, { timeout: 120_000 });
	await s.close();
	s.assertWellFormed();
	return s;
}

test("C1: an edited cell keeps only its newest value in the payload", async (t) => {
	const s = await run(t, editedTwice);

	const results = s.results(s.lastTurn());
	assert.equal(results.length, 3, `expected three tool results, got:\n${results.join("\n--\n")}`);
	const [first, second, third] = results;

	// The id line is never collapsed: it names the cell the later edits target.
	const id = first.match(/^id: (\S+)/m)?.[1];
	assert.ok(id, `no cell id in the first result:\n${first}`);

	assert.match(first, new RegExp(`- superseded: ${id}`));
	assert.match(second, new RegExp(`- superseded: ${id}`));
	assert.match(third, new RegExp(`^\\* ${id} ran .*\\s3$`, "m"));

	// The superseded values are gone, not merely marked.
	assert.doesNotMatch(first, /\s1$/m);
	assert.doesNotMatch(second, /\s2$/m);

	// Whole-kernel snapshots survive only on the newest message.
	assert.doesNotMatch(first, /globals:/);
	assert.doesNotMatch(second, /globals:/);
	assert.match(third, /globals: total=3/);

	// ...and none of that reached the session file, which is the record pi keeps
	// and the human reads. The filter is a payload rewrite, not an edit.
	const recorded = s.sessionText();
	assert.match(recorded, /total=1/);
	assert.match(recorded, /total=2/);
	assert.doesNotMatch(recorded, /superseded/);
});

test("C2: captured stdout goes with the value it belonged to", async (t) => {
	const sentinel = "SENTINEL-STDOUT";
	const s = await run(t, [
		{ tool: "py_cell", args: { src: `print("${sentinel}")\nq = 1\nq` } },
		{ tool: "py_cell", args: { id: LAST_ID, src: `print("${sentinel}")\nq = 2\nq` } },
		{ text: DONE },
	]);

	// It was there while it was current — this is not a test of a cell that
	// never printed.
	assert.match(s.flat(s.turn(2)), new RegExp(sentinel));

	const [first, second] = s.results(s.lastTurn());
	assert.doesNotMatch(first, new RegExp(sentinel));
	assert.match(second, new RegExp(sentinel));
});

test("C3: an accumulator keeps the history the kernel says it has", async (t) => {
	// The end-to-end path for `stateful`: derived in py/protocol.py from the
	// cell's own AST, carried on the tool result's details, read by the filter.
	const s = await run(t, [
		{ tool: "py_cell", args: { src: "try:\n    c = c + 1\nexcept NameError:\n    c = 0\nc" } },
		{ tool: "py_kernel", args: { op: "rerun", id: LAST_ID } },
		{ text: DONE },
	]);

	const [first, second] = s.results(s.lastTurn());
	const id = first.match(/^id: (\S+)/m)?.[1];
	assert.ok(id, `no cell id in:\n${first}`);
	// 0 then 1 is the record of an accumulator advancing, not a stale copy of
	// one truth, so neither value is collapsed.
	assert.match(first, new RegExp(`^\\* ${id} ran .*\\s0$`, "m"));
	assert.match(second, new RegExp(`^\\* ${id} ran .*\\s1$`, "m"));
	assert.doesNotMatch(first, /superseded/);
});

test("C4: a cached cell does not bury the message holding its value", async (t) => {
	// Editing `a` without changing what it evaluates to leaves `b`'s inputs
	// identical, so b re-reports as cached. Cached means *unchanged since it
	// last ran*, which makes the older message still true — collapsing it would
	// delete the only copy of b's value, since a cached cell renders as a count.
	//
	// `b` deliberately has no trailing display expression. A cell that displays
	// its own global reads it, so the global lands in `refs` and therefore in
	// the cell's own cache key — where it is absent on the first run and present
	// on the next. Such a cell re-runs once before it can ever report cached.
	const s = await run(t, [
		{ tool: "py_cell", args: { src: "a = 1\na" } },
		{ tool: "py_cell", args: { src: "b = a + 1" } },
		{ tool: "py_cell", args: { id: nthId(1), src: "a = 1  # touched\na" } },
		{ text: DONE },
	]);

	const [madeA, madeB, edited] = s.results(s.lastTurn());
	const idB = madeB.match(/^id: (\S+)/m)?.[1];
	assert.ok(idB, `no cell id in:\n${madeB}`);

	assert.match(edited, /cached \(unchanged\)/, `expected a cached cell in:\n${edited}`);
	assert.match(madeB, new RegExp(`^\\* ${idB} ran`, "m"));
	assert.doesNotMatch(madeB, /superseded/);
	// `a` really was re-run, so its own earlier value is gone.
	const idA = madeA.match(/^id: (\S+)/m)?.[1];
	assert.match(madeA, new RegExp(`- superseded: ${idA}`));
});

test("C5: with the filter off the payload is the unfiltered transcript", async (t) => {
	const s = await run(t, editedTwice, { PI_PY_CONTEXT_FILTER: "0" });

	const results = s.results(s.lastTurn());
	assert.equal(results.length, 3);
	assert.doesNotMatch(s.flat(s.lastTurn()), /superseded/);
	// Every value still there, and every message still carrying its own tail.
	assert.match(results[0], /globals: total=1/);
	assert.match(results[1], /globals: total=2/);
	assert.match(results[2], /globals: total=3/);
});

test("C6: a mutation made through /py raises the beacon", async (t) => {
	const stopped = "FIRST-STOP";
	const s = await session(t, {
		faux: [
			{ tool: "py_cell", args: { src: "k = 1\nk" } },
			{ text: stopped },
			{ text: DONE },
		],
	});
	await s.command("go");
	await s.expect(stopped, { timeout: 120_000 });

	// A slash command mutates the kernel and leaves nothing in the transcript,
	// so nothing supersedes anything — only the mutation counter moves.
	await s.command("/py add drift extra = 1");
	await s.expect("extra=1", { timeout: 60_000 });

	await s.command("carry on");
	await s.expect(DONE, { timeout: 120_000 });
	await s.close();
	s.assertWellFormed();

	assert.doesNotMatch(s.flat(s.turn(2)), /changed outside this transcript/);
	assert.match(s.flat(s.turn(3)), /changed outside this transcript/);
});

test("C7: a kernel restart voids everything recorded before it", async (t) => {
	const s = await run(t, [
		{ tool: "py_cell", args: { src: "before = 1\nbefore" } },
		{ tool: "py_cell", args: { src: "import os\nos._exit(1)" } },
		{ tool: "py_cell", args: { src: "after = 2\nafter" } },
		{ text: DONE },
	]);

	const [first, killer, rebuilt] = s.results(s.lastTurn());
	// The process that held these values is gone, and so are the cells.
	assert.match(first, /superseded by a kernel restart/);
	assert.doesNotMatch(first, /before=1/);
	assert.match(killer, /superseded by a kernel restart/);
	// The first message written after the respawn still says so in full.
	assert.match(rebuilt, /all Python state was lost/);
});
