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
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { session } from "./session.ts";

/** Some interpreter that really is on this machine — /opt in the image, /usr on a host. */
const SYSTEM_PYTHON = execFileSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim();

test("W1: /nb on an empty notebook says it is empty, and which one", async (t) => {
	const s = await session(t);
	await s.command("/nb");
	// The name is on the listing because a session is always on some notebook,
	// and "empty" means nothing until you know which one is empty.
	await s.expect('(notebook "default" is empty)');
	await s.close();
});

test("W2: /nb add creates a cell and shows the generated id", async (t) => {
	const s = await session(t);
	await s.command("/nb add x = 41");
	await s.expect("id: c1");
	await s.expect("globals: x=41");
	// Everything after `add` is source, first word included. An optional name
	// slot ahead of it made this a SyntaxError: `import` was read as the name
	// and `math` as the whole cell.
	await s.command("/nb add import math");
	await s.expect("id: c2");
	await s.command("/nb read c2");
	await s.expect("import math");
	await s.close();
});

test("W3: /nb <expr> evaluates without creating a cell", async (t) => {
	const s = await session(t);
	await s.command("/nb add x = 41");
	await s.expect("globals: x=41");
	await s.command("/nb x + 1");
	await s.expect("42");
	await s.command("/nb");
	await s.expect("1 cell"); // still just the one — eval mints nothing
	await s.close();
});

test("W4: editing a cell reports the cells it left behind", async (t) => {
	const s = await session(t);
	await s.command("/nb add a = 1");
	await s.expect("id: c1");
	await s.command("/nb add b = a + 1");
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
	await s.command("/nb add a = 1");
	await s.expect("id: c1");
	await s.command("/nb add b = a + 1");
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
	await s.command("/nb add y = undefined_name");
	await s.expect("NameError");
	await s.expect("failing: c1");
	// The kernel still serves the next command.
	await s.command("/nb 1 + 1");
	await s.expect("2");
	await s.close();
});

test("W7: /nb read shows a cell's full source", async (t) => {
	const s = await session(t);
	await s.command("/nb add msg = 'hello there'");
	await s.expect("id: c1");
	await s.command("/nb read c1");
	await s.expect("--- c1");
	await s.expect("msg = 'hello there'");
	await s.close();
});

test("W8: /nb save writes a percent-format file and /nb open reads it back", async (t) => {
	const s = await session(t);
	const path = join(s.root, "scratch.py");
	await s.command("/nb add value = 7");
	await s.expect("globals: value=7");
	await s.command(`/nb save ${path}`);
	await s.expect("saved 1 cell");
	await s.close();

	// Read the file only after pi has exited — the kernel writes it from a
	// subprocess, and asserting while the session is live races that.
	assert.equal(existsSync(path), true, `expected a notebook at ${path}`);
	const text = readFileSync(path, "utf8");
	assert.match(text, /^# %% id="c1"$/m);
	assert.match(text, /^value = 7$/m);
});

test("W9: /nb open loads a hand-written percent file, unrun", async (t) => {
	const s = await session(t);
	const path = join(s.root, "handwritten.py");
	writeFileSync(path, '# %% one\nn = 3\n\n# %% two\nn * 4\n', "utf8");
	await s.command(`/nb open ${path}`);
	await s.expect("loaded 2 cell");
	// The `one` and `two` on those headers are jupytext's title slot. A cell has
	// no title here, so they are read past: the sources still load and run.
	// No outputs in the format, so both cells come back unrun.
	await s.expect("unrun: c1, c2");
	await s.command("/nb run-all");
	await s.expect("12");
	await s.close();
});

test("W10: /nb-python with no argument explains itself instead of pinning", async (t) => {
	const s = await session(t);
	await s.command("/nb-python");
	// It reports before it offers: which notebook, and what that notebook is
	// currently running — the pin is per notebook now, so naming it matters.
	await s.expect('notebook "default" runs');
	await s.expect("Usage:");
	await s.expect("pins this notebook only");
	await s.close();
});

test("W11: /nb new switches to a notebook of its own, and /nb use comes back", async (t) => {
	const s = await session(t);
	await s.command("/nb add kept = 1");
	await s.expect("globals: kept=1");

	// A new notebook is a new namespace and a new interpreter, so the variable
	// must not follow it across.
	await s.command("/nb new sales");
	await s.expect('notebook "sales"');
	await s.command("/nb");
	await s.expect('(notebook "sales" is empty)');

	await s.command("/nb notebooks");
	await s.expect("sales");
	await s.expect("default");

	// Back again: the checkpoint written after every change is what makes the
	// cell survive a round trip through another notebook.
	await s.command("/nb use default");
	await s.expect("loaded 1 cell");
	await s.command("/nb read c1");
	await s.expect("kept = 1");
	await s.close();
});

test("W12: a notebook name that is a path is refused, not escaped", async (t) => {
	const s = await session(t);
	await s.command("/nb new ../escape");
	await s.expect("invalid notebook name");
	// Still on the notebook it started on.
	await s.command("/nb");
	await s.expect('(notebook "default" is empty)');
	await s.close();
});

test("W13: /nb drop-venv removes one notebook's venv, and says so twice over", async (t) => {
	const s = await session(t);
	// The venv is built lazily, on the first kernel call after the switch —
	// so the /nb is what puts one on disk for this case to reclaim.
	await s.command("/nb new sales");
	await s.expect('notebook "sales"');
	await s.command("/nb");
	await s.expect('(notebook "sales" is empty)');
	await s.command("/nb use default");
	await s.expect('notebook "default"');

	// Only the leading line: this response's tail is the "untouched — it is
	// source" note, which the toast stacking clips (see the file header).
	await s.command("/nb drop-venv sales");
	await s.expect('removed the venv for "sales"');
	// Idempotent, and it says which of the two things happened — the human is
	// reclaiming disk and wants to know whether there was any to reclaim.
	await s.command("/nb drop-venv sales");
	await s.expect('notebook "sales" has no venv to remove');

	// Same validation as `new`: the name is a path segment under the venv root.
	await s.command("/nb drop-venv ../escape");
	await s.expect("invalid notebook name");
	await s.close();
});

test("W14: dropping a venv a pin had stranded costs the session nothing", async (t) => {
	const s = await session(t);
	// Build the venv, then pin past it. From here the kernel runs the pinned
	// interpreter and the venv is dead disk — which is the state /nb notebooks
	// now advertises, so reclaiming it has to be safe.
	await s.command("/nb add first = 1");
	await s.expect("globals: first=1");
	await s.command(`/nb-python ${SYSTEM_PYTHON}`);
	await s.expect("kernel will restart");

	await s.command("/nb add alive = 424242");
	await s.expect("globals: alive=424242");
	await s.command("/nb notebooks");
	await s.expect("built, unused");

	await s.command("/nb drop-venv default");
	await s.expect('removed the venv for "default"');

	// The point of the case. `current` alone would have killed the kernel here
	// and promised a rebuild resolvePython never performs, since the pin still
	// decides what runs. The namespace surviving is what proves it did not.
	await s.command("/nb alive");
	await s.expect("424242");
	await s.close();
});
