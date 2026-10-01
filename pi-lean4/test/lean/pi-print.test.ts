// pi itself, in print mode, with the extension and a scripted model: the
// extension's entry point and its lifecycle, for free and deterministically.
//
// The lifecycle claim is checked directly: every process group the extension
// spawned is written to a pidfile, and each must be gone once pi has exited —
// which is session_shutdown(quit) doing its job (or, failing that, the
// process-exit safety net).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { groupAlive } from "../../src/lean/process.ts";
import { USE, project } from "./fixture.ts";
import { piPrint, toolResults } from "./pi-print.ts";

const DONE = "SCRIPT-COMPLETE";

function autoproveEntries(sessionText: string): { status: string; reason?: string; cycles: number }[] {
	return sessionText
		.split("\n")
		.filter((l) => l.includes('"customType":"lean-autoprove"') && l.includes('"type":"custom"'))
		.map((l) => JSON.parse(l) as { data: { status: string; stop?: { reason: string }; cycles: number } })
		.map((e) => ({ status: e.data.status, reason: e.data.stop?.reason, cycles: e.data.cycles }));
}

test("PP1: a tool call starts one server; pi's exit stops it", async (t) => {
	const p = project(t);
	p.build();
	const r = await piPrint(p.root, "go", {
		faux: [{ tool: "lean_diagnostics", args: { path: "Fixture/Use.lean" } }, { tool: "lean_goal", args: { path: "Fixture/Use.lean", line: 9 } }, { text: DONE }],
	});
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, new RegExp(DONE));
	assert.match(toolResults(r, "lean_diagnostics")[0] ?? "", /1 sorry/);
	assert.match(toolResults(r, "lean_goal")[0] ?? "", /⊢ a \+ b = b \+ a/);
	assert.equal(r.pgids.length, 1, "two tools, one server");
	assert.deepEqual(r.pgids.filter(groupAlive), [], "a Lean server outlived pi");
});

test("PP2: an edit to a .lean file comes back with the auto-check appended", async (t) => {
	const p = project(t);
	p.build();
	const r = await piPrint(p.root, "go", {
		env: { PI_LEAN_AUTOCHECK: "always" },
		faux: [{ tool: "edit", args: { path: "Fixture/Use.lean", edits: [{ oldText: "  sorry", newText: "  boom" }] } }, { text: DONE }],
	});
	assert.equal(r.code, 0, r.stderr);
	const edit = toolResults(r, "edit")[0] ?? "";
	assert.match(edit, /\[lean auto-check\] Fixture\/Use\.lean: 2 error\(s\), 0 sorry/);
	assert.match(edit, /error 9:4 unknown tactic/);
	assert.deepEqual(r.pgids.filter(groupAlive), []);
});

test("PP3: lean_build twice — the second is skipped without invoking lake", async (t) => {
	const p = project(t);
	const r = await piPrint(p.root, "go", {
		faux: [{ tool: "lean_build", args: {} }, { tool: "lean_build", args: {} }, { text: DONE }],
	});
	assert.equal(r.code, 0, r.stderr);
	const [first, second] = toolResults(r, "lean_build");
	assert.match(first, /lake build succeeded/);
	assert.match(second, /up to date — .*lake was not invoked/);
});

test("PP4: an op error reaches the model as an error result, and pi carries on", async (t) => {
	const p = project(t);
	const r = await piPrint(p.root, "go", {
		faux: [{ tool: "lean_goal", args: { path: "Nowhere.lean", line: 1 } }, { text: DONE }],
	});
	assert.equal(r.code, 0, r.stderr);
	const turns = r.turns();
	const result = turns[turns.length - 1].messages.find((m) => m.role === "toolResult") as { isError?: boolean; content: { text: string }[] };
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /does not exist/);
});

test("AP-PP1: /lean autoprove runs headless to completion", async (t) => {
	const p = project(t);
	p.build();
	const r = await piPrint(p.root, "/lean autoprove Fixture/Use.lean", {
		faux: [{ tool: "edit", args: { path: "Fixture/Use.lean", edits: [{ oldText: "  sorry", newText: "  omega" }] } }, { text: "<autoprove-status>\nremaining: 0\n</autoprove-status>" }],
	});
	assert.equal(r.code, 0, r.stderr);
	assert.match(readFileSync(p.path("Fixture/Use.lean"), "utf8"), /omega/);
	const entries = autoproveEntries(r.sessionText());
	assert.deepEqual(entries[entries.length - 1], { status: "stopped", reason: "completion", cycles: 1 });
	const kickoff = r.turns()[0].messages.find((m) => m.role === "user");
	assert.match(JSON.stringify(kickoff), /\[lean autoprove\] cycle 1\/20 target=Fixture\/Use\.lean/);
	assert.deepEqual(r.pgids.filter(groupAlive), []);
});

test("AP-PP2: a model that makes no progress is stopped after the stuck budget", async (t) => {
	const p = project(t);
	p.build();
	const r = await piPrint(p.root, "/lean autoprove Fixture/Use.lean --max-stuck=2", { faux: [{ text: "thinking about it" }] });
	assert.equal(r.code, 0, r.stderr);
	const entries = autoproveEntries(r.sessionText());
	assert.deepEqual(entries[entries.length - 1], { status: "stopped", reason: "max-stuck", cycles: 2 });
	assert.equal(readFileSync(p.path("Fixture/Use.lean"), "utf8"), USE);
});

test("AP-PP3: the cycle budget stops a loop that keeps (barely) progressing", async (t) => {
	const p = project(t, {
		"Fixture/Basic.lean": "theorem a : True := sorry\ntheorem b : True := sorry\ntheorem c : True := sorry\n",
	});
	p.build();
	const r = await piPrint(p.root, "/lean autoprove Fixture/Basic.lean --max-cycles=2 --max-stuck=5", {
		faux: [
			{ tool: "edit", args: { path: "Fixture/Basic.lean", edits: [{ oldText: "theorem a : True := sorry", newText: "theorem a : True := trivial" }] } },
			{ text: "one done" },
			{ tool: "edit", args: { path: "Fixture/Basic.lean", edits: [{ oldText: "theorem b : True := sorry", newText: "theorem b : True := trivial" }] } },
			{ text: "two done" },
		],
	});
	assert.equal(r.code, 0, r.stderr);
	const entries = autoproveEntries(r.sessionText());
	assert.deepEqual(entries[entries.length - 1], { status: "stopped", reason: "max-cycles", cycles: 2 });
	assert.match(readFileSync(p.path("Fixture/Basic.lean"), "utf8"), /theorem c : True := sorry/);
});
