// Offline TUI cases: drive the /nb commands through pi's real TUI in a pty
// and assert what the user sees. The kernel side is real (stdlib python3);
// no model is involved, so these are free and deterministic.
//
// One property of the harness shapes every case here: pi renders a slash
// command's output as a toast, and when a previous toast is still stacked the
// new one's *last* lines are clipped off the bottom of an 80x24 pty. The hint
// tails (`stale`, `unrun`, `globals`) are last by design, so they are the first
// thing to go. Assertions therefore key on a response's leading lines. The
// tails are asserted where the whole response is visible: test-py/ for the
// kernel's answer, test/format.test.ts for the rendering, and
// test/container/test_protocol_in_image.sh for both over the wire.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { session } from "./session.ts";

test("W1: /nb on an empty notebook says it is empty", async (t) => {
	const s = await session(t);
	await s.command("/nb");
	await s.expect("(empty notebook)");
	await s.close();
});

test("W2: /nb add creates a cell and shows the generated id", async (t) => {
	const s = await session(t);
	await s.command("/nb add base x = 41");
	await s.expect("id: c1");
	await s.expect("globals: x=41");
	await s.close();
});

test("W3: /nb <expr> evaluates without creating a cell", async (t) => {
	const s = await session(t);
	await s.command("/nb add base x = 41");
	await s.expect("globals: x=41");
	await s.command("/nb x + 1");
	await s.expect("42");
	await s.command("/nb");
	await s.expect("1 cell"); // still just the one — eval mints nothing
	await s.close();
});

test("W4: editing a cell reports the cells it left behind", async (t) => {
	const s = await session(t);
	await s.command("/nb add first a = 1");
	await s.expect("id: c1");
	await s.command("/nb add second b = a + 1");
	await s.expect("globals: a=1, b=2");
	// The /nb command has no edit verb, so drive the staleness report through
	// a second cell that runs after the first — same mechanism, one step on.
	await s.command("/nb run c1");
	await s.expect("stale");
	await s.expect("c2");
	await s.close();
});

test("W5: /nb run-all replays every cell from the top", async (t) => {
	const s = await session(t);
	await s.command("/nb add first a = 1");
	await s.expect("id: c1");
	await s.command("/nb add second b = a + 1");
	await s.expect("globals: a=1, b=2");
	await s.command("/nb run c1");
	await s.expect("stale");

	await s.command("/nb run-all");
	// Execution counts restarting at 1 is the visible evidence of a replay: it
	// only happens because run_all threw the namespace away first. That the
	// replay also empties the staleness report is asserted where the whole
	// response can be seen — see the header note.
	await s.expect("* [1] c1");
	await s.expect("* [2] c2");
	await s.close();
});

test("W6: a failing cell reports the traceback, not a dead kernel", async (t) => {
	const s = await session(t);
	await s.command("/nb add bad y = undefined_name");
	await s.expect("NameError");
	await s.expect("failing: c1");
	// The kernel still serves the next command.
	await s.command("/nb 1 + 1");
	await s.expect("2");
	await s.close();
});

test("W7: /nb read shows a cell's full source", async (t) => {
	const s = await session(t);
	await s.command("/nb add greet msg = 'hello there'");
	await s.expect("id: c1");
	await s.command("/nb read c1");
	await s.expect("c1 (greet)");
	await s.expect("msg = 'hello there'");
	await s.close();
});

test("W8: /nb save writes a percent-format file and /nb open reads it back", async (t) => {
	const s = await session(t);
	const path = join(s.root, "scratch.py");
	await s.command("/nb add setup value = 7");
	await s.expect("globals: value=7");
	await s.command(`/nb save ${path}`);
	await s.expect("saved 1 cell");
	await s.close();

	// Read the file only after pi has exited — the kernel writes it from a
	// subprocess, and asserting while the session is live races that.
	assert.equal(existsSync(path), true, `expected a notebook at ${path}`);
	const text = readFileSync(path, "utf8");
	assert.match(text, /^# %% setup id="c1"$/m);
	assert.match(text, /^value = 7$/m);
});

test("W9: /nb open loads a hand-written percent file, unrun", async (t) => {
	const s = await session(t);
	const path = join(s.root, "handwritten.py");
	writeFileSync(path, '# %% one\nn = 3\n\n# %% two\nn * 4\n', "utf8");
	await s.command(`/nb open ${path}`);
	await s.expect("loaded 2 cell");
	// No outputs in the format, so both cells come back unrun.
	await s.expect("unrun: c1, c2");
	await s.command("/nb run-all");
	await s.expect("12");
	await s.close();
});

test("W10: /nb-python with no argument explains itself instead of pinning", async (t) => {
	const s = await session(t);
	await s.command("/nb-python");
	await s.expect("Usage:");
	await s.expect(".notebook/python-pin");
	await s.close();
});
