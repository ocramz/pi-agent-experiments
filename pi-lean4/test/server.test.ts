// LeanServer and LeanRuntime against the scripted fake in fixtures/fake-lsp.mjs.
//
// What these pin down is the client's bookkeeping — what is sent, when, and how
// often — which the real server would make slow and nondeterministic to assert.
// Lean's own behaviour is pinned by test/lean/contract.test.ts.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { LeanToolError } from "../src/errors.ts";
import { groupAlive, liveGroups, pidAlive, safetyNetCount } from "../src/lean/process.ts";
import { LeanRuntime } from "../src/lean/runtime.ts";

const FAKE = resolve(import.meta.dirname, "fixtures", "fake-lsp.mjs");

const unhandled: unknown[] = [];
process.on("unhandledRejection", (err) => unhandled.push(err));

interface Fixture {
	root: string;
	logFile: string;
	log(): any[];
	sent(method: string): any[];
	rt: LeanRuntime;
}

function project(dir: string, files: Record<string, string>): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "lean-toolchain"), "leanprover/lean4:v4.34.1\n");
	writeFileSync(join(dir, "lakefile.toml"), 'name = "fixture"\n');
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), text);
	}
}

function fixture(
	t: TestContext,
	opts: { scenario?: Record<string, unknown>; maxOpenFiles?: number; files?: Record<string, string>; elaborationTimeoutMs?: number } = {},
): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pi-lean4-server-"));
	project(root, opts.files ?? { "A.lean": "theorem a : True := trivial\n", "B.lean": "theorem b : True := by\n  sorry\n" });
	const logFile = join(root, ".fake.log");
	const rt = new LeanRuntime({
		config: () => ({
			offline: false,
			maxOpenFiles: opts.maxOpenFiles ?? 4,
			scratchSlots: 1,
			requestTimeoutMs: 5000,
			elaborationTimeoutMs: opts.elaborationTimeoutMs ?? 5000,
			startTimeoutMs: 5000,
		}),
		clientVersion: "test",
		command: () => ({ cmd: process.execPath, args: [FAKE] }),
		env: { ...process.env, FAKE_LSP_LOG: logFile, FAKE_LSP_SCENARIO: JSON.stringify(opts.scenario ?? {}) },
	});
	t.after(async () => {
		await rt.dispose();
		rmSync(root, { recursive: true, force: true });
	});
	const log = () =>
		existsSync(logFile)
			? readFileSync(logFile, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
	return { root, logFile, log, sent: (m) => log().filter((e) => e.method === m), rt };
}

/**
 * Notifications are fire-and-forget, so the fake may not have logged the last
 * ones when a call returns. A request round-trip behind them proves it has: the
 * fake handles its input in order.
 */
async function flush(f: Fixture): Promise<void> {
	if (f.rt.running()) await f.rt.running()!.workspaceSymbol("", 2000);
}

test("S1: five concurrent first calls start one server", async (t) => {
	const f = fixture(t);
	const file = join(f.root, "A.lean");
	const results = await Promise.all(
		Array.from({ length: 5 }, () => f.rt.use(f.root, (s) => s.withDocument(file, async (d) => d.version))),
	);
	assert.equal(f.sent("initialize").length, 1);
	assert.equal(f.sent("textDocument/didOpen").length, 1);
	assert.deepEqual(
		results.map((r) => r.value),
		[1, 1, 1, 1, 1],
	);
});

test("S2/S3: open says never; an unchanged file is neither re-sent nor re-elaborated", async (t) => {
	const f = fixture(t);
	const file = join(f.root, "B.lean");
	const first = await f.rt.use(f.root, (s) => s.withDocument(file, (d) => d.diagnostics()));
	const second = await f.rt.use(f.root, (s) => s.withDocument(file, (d) => d.diagnostics()));
	assert.equal(f.sent("textDocument/didOpen")[0].params.dependencyBuildMode, "never");
	assert.equal(f.sent("textDocument/didChange").length, 0);
	assert.equal(f.sent("textDocument/waitForDiagnostics").length, 1, "the barrier is cached per version");
	assert.equal(first.value.complete, true);
	assert.match(first.value.items[0].message, /sorry/);
	assert.deepEqual(second.value.items, first.value.items);
});

test("S4: a changed file is re-sent whole, saved, and re-elaborated", async (t) => {
	const f = fixture(t);
	const file = join(f.root, "A.lean");
	await f.rt.use(f.root, (s) => s.withDocument(file, (d) => d.diagnostics()));
	writeFileSync(file, "theorem a : True := boom\n");
	const r = await f.rt.use(f.root, (s) => s.withDocument(file, (d) => d.diagnostics()));
	const change = f.sent("textDocument/didChange");
	assert.equal(change.length, 1);
	assert.equal(change[0].params.textDocument.version, 2);
	assert.equal(change[0].params.contentChanges[0].text, "theorem a : True := boom\n");
	assert.equal(f.sent("textDocument/didSave").length, 1);
	assert.equal(f.sent("textDocument/waitForDiagnostics").length, 2);
	assert.equal(r.value.version, 2);
	assert.match(r.value.items[0].message, /unknown identifier/);
});

for (const kind of ["must", "should"]) {
	test(`S5: "imports ${kind} be rebuilt" reopens once with dependencyBuildMode once`, async (t) => {
		const f = fixture(t, { scenario: { outOfDate: kind } });
		const file = join(f.root, "B.lean");
		const r = await f.rt.use(f.root, (s) => s.withDocument(file, (d) => d.diagnostics()));
		const opens = f.sent("textDocument/didOpen").map((m) => m.params.dependencyBuildMode);
		assert.deepEqual(opens, ["never", "once"]);
		assert.equal(f.sent("textDocument/didClose").length, 1);
		assert.ok(r.value.reopened, "the report says the imports were rebuilt");
		assert.ok(!r.value.items.some((d) => /out of date/.test(d.message)));
		// And never a loop: asking again does not reopen again.
		await f.rt.use(f.root, (s) => s.withDocument(file, (d) => d.diagnostics()));
		assert.equal(f.sent("textDocument/didOpen").length, 2);
	});
}

test("S5b: a positional request on a file whose header failed is repaired and retried once", async (t) => {
	const f = fixture(t, { scenario: { outOfDate: "must" } });
	const file = join(f.root, "A.lean");
	const goal = await f.rt.use(f.root, (s) =>
		s.withDocument(file, async (d) => {
			await d.diagnostics({ timeoutMs: 1 }).catch(() => {});
			return d.request<any>("$/lean/plainGoal", { textDocument: { uri: d.uri }, position: d.pos(1, 1) });
		}),
	);
	assert.match(goal.value.goals[0], /goal at 0:0/);
	assert.deepEqual(
		f.sent("textDocument/didOpen").map((m) => m.params.dependencyBuildMode),
		["never", "once"],
	);
});

test("S6: an edit to an unopened import reopens the importer with once", async (t) => {
	const f = fixture(t, {
		files: {
			"Fixture/Basic.lean": "def x := 1\n",
			"Fixture/Use.lean": "import Fixture.Basic\ntheorem u : x = 1 := rfl\n",
		},
	});
	const use = join(f.root, "Fixture/Use.lean");
	await f.rt.use(f.root, (s) => s.withDocument(use, (d) => d.diagnostics()));
	await f.rt.use(f.root, (s) => s.withDocument(use, (d) => d.diagnostics()));
	assert.equal(f.sent("textDocument/didOpen").length, 1, "nothing changed: no reopen");
	writeFileSync(join(f.root, "Fixture/Basic.lean"), "def x := 1\ndef y := 2\n");
	const later = new Date(Date.now() + 5000);
	utimesSync(join(f.root, "Fixture/Basic.lean"), later, later);
	await f.rt.use(f.root, (s) => s.withDocument(use, (d) => d.diagnostics()));
	assert.deepEqual(
		f.sent("textDocument/didOpen").map((m) => m.params.dependencyBuildMode),
		["never", "once"],
	);
	assert.equal(f.sent("textDocument/didChange").length, 0, "Use.lean itself did not change");
});

test("S7: least-recently-used documents are closed past the cap, never a busy one", async (t) => {
	const files: Record<string, string> = {};
	for (const n of ["A", "B", "C"]) files[`${n}.lean`] = `theorem ${n.toLowerCase()} : True := trivial\n`;
	const f = fixture(t, { maxOpenFiles: 1, files });
	const p = (n: string) => join(f.root, `${n}.lean`);
	await f.rt.use(f.root, (s) =>
		s.withDocument(p("A"), async () => {
			// A is busy while B and C open: A must survive, B is evicted for C.
			await s.withDocument(p("B"), async () => {});
			await s.withDocument(p("C"), async () => {});
		}),
	);
	await flush(f);
	const closed = f.sent("textDocument/didClose").map((m) => m.params.textDocument.uri.split("/").pop());
	assert.ok(!closed.slice(0, 1).includes("A.lean"), `A was closed while busy: ${closed}`);
	assert.ok(closed.includes("B.lean"));
});

test("S8: a graceful stop sends shutdown and exit and leaves no process group", async (t) => {
	const f = fixture(t);
	const { value: pid } = await f.rt.use(f.root, async (s) => s.pid);
	assert.ok(liveGroups().has(pid));
	await f.rt.stop();
	assert.equal(f.sent("shutdown").length, 1);
	assert.equal(f.sent("exit").length, 1);
	assert.equal(groupAlive(pid), false);
	assert.equal(liveGroups().has(pid), false);
});

test("S9: a server that ignores shutdown is killed, with its own-group grandchild", async (t) => {
	const f = fixture(t, { scenario: { ignoreShutdown: true, grandchild: true } });
	const { value: pid } = await f.rt.use(f.root, async (s) => s.pid);
	let grandchild = 0;
	for (let i = 0; i < 50 && !grandchild; i++) {
		grandchild = f.log().find((e) => e.grandchild)?.grandchild ?? 0;
		if (!grandchild) await new Promise((r) => setTimeout(r, 50));
	}
	assert.ok(grandchild > 0, "the fake logged its grandchild");
	assert.ok(pidAlive(grandchild));
	await f.rt.dispose();
	assert.equal(groupAlive(pid), false);
	assert.equal(pidAlive(grandchild), false, "a worker in its own process group was left running");
});

test("S10: a crash fails the call in flight; the next call restarts and says so", async (t) => {
	const f = fixture(t, { scenario: { crashOn: "$/lean/plainGoal" } });
	const file = join(f.root, "A.lean");
	await assert.rejects(
		f.rt.use(f.root, (s) =>
			s.withDocument(file, (d) => d.request("$/lean/plainGoal", { textDocument: { uri: d.uri }, position: d.pos(1, 1) })),
		),
		LeanToolError,
	);
	await new Promise((r) => setTimeout(r, 100));
	const again = await f.rt.use(f.root, (s) => s.withDocument(file, async (d) => d.version));
	assert.equal(f.sent("initialize").length, 2);
	assert.match(again.notes.join("\n"), /exited unexpectedly.*restarted/s);
});

test("S10b: a crashed worker is reported, and its document reopened on the next call", async (t) => {
	const f = fixture(t, { scenario: { workerCrashOn: "$/lean/plainGoal" } });
	const file = join(f.root, "A.lean");
	await assert.rejects(
		f.rt.use(f.root, (s) =>
			s.withDocument(file, (d) => d.request("$/lean/plainGoal", { textDocument: { uri: d.uri }, position: d.pos(1, 1) })),
		),
		/worker .* crashed/,
	);
	await f.rt.use(f.root, (s) => s.withDocument(file, async () => {}));
	await flush(f);
	assert.equal(f.sent("textDocument/didOpen").length, 2);
	assert.equal(f.sent("initialize").length, 1, "a worker crash is not a server restart");
});

test("S11: a call about another project moves the one server there", async (t) => {
	const f = fixture(t);
	const other = mkdtempSync(join(tmpdir(), "pi-lean4-server-other-"));
	t.after(() => rmSync(other, { recursive: true, force: true }));
	project(other, { "Z.lean": "theorem z : True := trivial\n" });
	const { value: first } = await f.rt.use(f.root, async (s) => s.pid);
	const moved = await f.rt.use(other, async (s) => s.pid);
	assert.notEqual(moved.value, first);
	assert.equal(groupAlive(first), false, "the old server was stopped, not left running");
	assert.match(moved.notes.join("\n"), /moved from/);
	assert.equal(f.rt.boundRoot(), other);
});

test("S12: stop and dispose are idempotent, and safe before anything started", async (t) => {
	const f = fixture(t);
	assert.equal(await f.rt.stop(), false);
	await f.rt.use(f.root, async () => {});
	assert.equal(await f.rt.stop(), true);
	assert.equal(await f.rt.stop(), false);
	await f.rt.dispose();
	await f.rt.dispose();
	await assert.rejects(f.rt.use(f.root, async () => {}), /session .* has ended/);
});

test("S13: the exit safety net is installed once per process, across re-imports", async () => {
	await import(`../src/lean/process.ts?again=${Date.now()}`);
	const mod = (await import(`../src/lean/process.ts?again2=${Date.now()}`)) as typeof import("../src/lean/process.ts");
	// Spawning through any copy installs the net if it was not already there.
	assert.equal(safetyNetCount(), 1);
	assert.equal(mod.safetyNetCount(), 1);
});

test("S14: scratch documents never reach the disk", async (t) => {
	const f = fixture(t);
	const r = await f.rt.use(f.root, (s) =>
		s.withScratch("theorem s : True := by\n  sorry\n", async (d) => ({ path: d.path, diags: await d.diagnostics() })),
	);
	assert.match(r.value.path, /_PiLean4Scratch0\.lean$/);
	assert.equal(existsSync(r.value.path), false);
	assert.match(r.value.diags.items[0].message, /sorry/);
	// A second use of the slot with different text is a didChange, not a new file.
	await f.rt.use(f.root, (s) => s.withScratch("theorem s : True := trivial\n", (d) => d.diagnostics()));
	assert.equal(f.sent("textDocument/didOpen").length, 1);
	assert.equal(f.sent("textDocument/didChange").length, 1);
	assert.equal(f.sent("textDocument/didSave").length, 0, "scratch text is never saved");
});

test("S15: a soft timeout returns a partial report rather than failing", async (t) => {
	const f = fixture(t, { scenario: { barrierDelayMs: 400 } });
	const file = join(f.root, "A.lean");
	const r = await f.rt.use(f.root, (s) => s.withDocument(file, (d) => d.diagnostics({ timeoutMs: 50 })));
	assert.equal(r.value.complete, false);
	// The barrier was not cancelled: the next call finds it settled.
	await new Promise((res) => setTimeout(res, 500));
	const again = await f.rt.use(f.root, (s) => s.withDocument(file, (d) => d.diagnostics({ timeoutMs: 50 })));
	assert.equal(again.value.complete, true);
	assert.equal(f.sent("textDocument/waitForDiagnostics").length, 1);
});

test("S16: nothing in this file produced an unhandled rejection", async () => {
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(unhandled, []);
});
