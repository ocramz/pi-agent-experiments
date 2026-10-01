// The human's surface and the failure paths, with no Lean on the machine (or
// none the extension is allowed to find): /lean, the templates, errors that
// say what to do, and the git guardrails.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { session, textOf } from "./session.ts";

const DONE = "SCRIPT-COMPLETE";

test("TC1: /lean status reports a missing lake with the remedy, and starts nothing", async (t) => {
	const s = await session(t, { lake: true });
	await s.command("/lean status");
	await s.expect("lake: NOT FOUND");
	await s.expect("server: not running");
	await s.expect("offline: off");
	await s.close();
});

test("TC2: /lean help, and /lean stop with nothing running", async (t) => {
	const s = await session(t);
	await s.command("/lean help");
	await s.expect("/lean autoprove <file>");
	await s.command("/lean stop");
	await s.expect("no Lean server was running");
	await s.close();
});

test("TC3: a tool call outside any Lake project is an error that says how to make one", async (t) => {
	const s = await session(t, { files: { "A.lean": "theorem a : True := trivial\n" }, faux: [{ tool: "lean_goal", args: { path: "A.lean", line: 1 } }, { text: DONE }] });
	await s.command("go");
	await s.expect(DONE, { timeout: 120_000 });
	await s.close();
	const turns = s.turns();
	const result = turns[turns.length - 1].messages.find((m) => m.role === "toolResult")!;
	assert.equal(result.isError, true);
	assert.match(textOf(result.content), /not inside a Lake project.*lake new/s);
});

test("TC4: inside a project but with no lake, the error names the install", async (t) => {
	const s = await session(t, { lake: true, files: { "A.lean": "theorem a : True := trivial\n" }, faux: [{ tool: "lean_diagnostics", args: { path: "A.lean" } }, { text: DONE }] });
	await s.command("go");
	await s.expect(DONE, { timeout: 120_000 });
	await s.close();
	const turns = s.turns();
	const result = turns[turns.length - 1].messages.find((m) => m.role === "toolResult")!;
	assert.equal(result.isError, true);
	assert.match(textOf(result.content), /cannot find lake.*elan/s);
});

test("TC5: /lean autoprove without lake refuses, and no loop starts", async (t) => {
	const s = await session(t, { lake: true, files: { "A.lean": "theorem a : True := sorry\n" } });
	await s.command("/lean autoprove A.lean");
	await s.expect("cannot find lake");
	await s.command("/lean status");
	await s.refute("autoprove: running");
	await s.close();
});

test("TC6: the guardrails stop git reset --hard in a Lean repository; the work survives", async (t) => {
	const s = await session(t, {
		lake: true,
		files: { "A.lean": "theorem a : True := trivial\n" },
		faux: [{ tool: "bash", args: { command: "git add -A >/dev/null; git -c user.email=t@t -c user.name=t commit -qm init; echo 'theorem b : True := trivial' >> A.lean; git reset --hard" } }, { text: DONE }],
	});
	execFileSync("git", ["init", "-q"], { cwd: s.root });
	await s.command("go");
	await s.expect(DONE, { timeout: 120_000 });
	await s.close();
	const turns = s.turns();
	const result = turns[turns.length - 1].messages.find((m) => m.role === "toolResult")!;
	assert.match(textOf(result.content), /Blocked by the Lean guardrails: git reset --hard/);
	assert.equal(readFileSync(join(s.root, "A.lean"), "utf8"), "theorem a : True := trivial\n", "the whole command was blocked, so nothing ran");
});

test("TC7: a prompt template expands into the skill's instructions", async (t) => {
	const s = await session(t, { lake: true, faux: [{ text: DONE }] });
	await s.command("/lean-review A.lean --stuck");
	await s.expect(DONE, { timeout: 120_000 });
	await s.close();
	const first = s.turns()[0].messages.find((m) => m.role === "user")!;
	const text = textOf(first.content);
	assert.match(text, /Read the `lean4-review` skill first/);
	assert.match(text, /Target and options: A\.lean --stuck/);
	assert.match(text, /Read-only: do not edit files/);
});
