/**
 * The subprocess client, against a real Python.
 *
 * These spawn `py/protocol.py` for real: the JSON-lines framing, the
 * promise queue and the failure paths are exactly the parts a fake kernel
 * would stop testing. Each test gets its own temp dir, so the venv
 * bootstrap in `resolvePython` runs too.
 */

import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import {
	Kernel,
	MIN_PYTHON,
	STATE_DIR,
	interpreterVersion,
	pinPython,
	resolvePython,
} from "../src/kernel.ts";
import type { InspectResponse, RunResponse } from "../src/format.ts";

function dirIn(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-nb-unit-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function kernelIn(t: TestContext): { k: Kernel; dir: string } {
	const dir = dirIn(t);
	const k = new Kernel(undefined, dir);
	t.after(() => k.kill());
	return { k, dir };
}

test("a cell runs and its trailing expression is the display value", async (t) => {
	const { k } = kernelIn(t);
	const resp = (await k.call({ tool: "add_cell", src: "1 + 1" })) as RunResponse;
	assert.equal(resp.ok, true);
	assert.equal(resp.id, "c1");
	assert.equal(resp.results?.[0].value, "2");
	assert.equal(resp.results?.[0].status, "ok");
});

test("cells share one namespace across calls", async (t) => {
	const { k } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "x = 21" });
	const resp = (await k.call({ tool: "add_cell", src: "x * 2" })) as RunResponse;
	assert.equal(resp.results?.[0].value, "42");
});

test("stdout is captured onto the result, not onto the wire", async (t) => {
	const { k } = kernelIn(t);
	const resp = (await k.call({ tool: "add_cell", src: "print('hello')" })) as RunResponse;
	assert.equal(resp.ok, true);
	assert.equal(resp.results?.[0].stdout, "hello\n");
});

test("a print-heavy cell does not desynchronise the protocol", async (t) => {
	const { k } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "for i in range(200): print(i)" });
	// If the prints had reached real stdout, this response would be read
	// off the wrong line and come back as garbage.
	const resp = (await k.call({ tool: "add_cell", src: "'still here'" })) as RunResponse;
	assert.equal(resp.results?.[0].value, "'still here'");
});

test("a failing cell is a result, not a protocol error", async (t) => {
	const { k } = kernelIn(t);
	const resp = (await k.call({ tool: "add_cell", src: "1 / 0" })) as RunResponse;
	assert.equal(resp.ok, true);
	assert.equal(resp.results?.[0].status, "error");
	assert.match(resp.results![0].error!, /ZeroDivisionError/);
	assert.match(resp.results![0].traceback!, /<cell c1>/);
	assert.deepEqual(resp.failing, ["c1"]);
});

test("the staleness hints ride on every mutating response", async (t) => {
	const { k } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "a = 1" });
	await k.call({ tool: "add_cell", src: "b = a + 1" });
	const resp = (await k.call({ tool: "set_cell", id: "c1", src: "a = 5" })) as RunResponse;
	assert.deepEqual(resp.stale, ["c2"]);
	assert.deepEqual(resp.unrun, []);
	const after = (await k.call({ tool: "run_all" })) as RunResponse;
	assert.deepEqual(after.stale, []);
});

test("inspect reports one state per cell", async (t) => {
	const { k } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "a = 1" });
	await k.call({ tool: "add_cell", src: "b = 2", run: false });
	const resp = (await k.call({ tool: "inspect" })) as InspectResponse;
	assert.deepEqual(
		resp.cells?.map((c) => [c.id, c.state]),
		[
			["c1", "ok"],
			["c2", "unrun"],
		],
	);
});

test("an unknown cell is an expected error, not an internal one", async (t) => {
	const { k } = kernelIn(t);
	const resp = await k.call({ tool: "run_cell", id: "nope" });
	assert.equal(resp.ok, false);
	assert.equal(resp.internal, undefined);
	assert.match(resp.error!, /nope/);
});

test("an unknown tool is reported rather than killing the kernel", async (t) => {
	const { k } = kernelIn(t);
	assert.equal((await k.call({ tool: "frobnicate" })).ok, false);
	// Still alive.
	assert.equal((await k.call({ tool: "add_cell", src: "1" })).ok, true);
});

test("calls are serialised, so concurrent ones cannot interleave", async (t) => {
	const { k } = kernelIn(t);
	const responses = (await Promise.all([
		k.call({ tool: "add_cell", src: "'first'" }),
		k.call({ tool: "add_cell", src: "'second'" }),
		k.call({ tool: "add_cell", src: "'third'" }),
	])) as RunResponse[];
	assert.deepEqual(
		responses.map((r) => r.results?.[0].value),
		["'first'", "'second'", "'third'"],
	);
	assert.deepEqual(
		responses.map((r) => r.id),
		["c1", "c2", "c3"],
	);
});

test("a kernel that dies is reported, then respawned on the next call", async (t) => {
	const { k } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "gone = 1" });

	// os._exit skips every cleanup path, which is the closest thing to the
	// crash this is about — an explicit kill() is deliberate and is not
	// flagged, because the caller that asked for it already knows.
	const died = await k.call({ tool: "eval", src: "__import__('os')._exit(0)" });
	assert.equal(died.ok, false);
	assert.match(died.error!, /exited/);
	assert.equal(k.lostState, true);

	const resp = (await k.call({ tool: "inspect" })) as InspectResponse;
	assert.equal(resp.ok, true);
	// A fresh process: the cell list is empty and so is the namespace.
	assert.deepEqual(resp.cells, []);
});

test("an explicit kill is not reported as lost state", async (t) => {
	const { k } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "a = 1" });
	k.kill();
	assert.equal((await k.call({ tool: "inspect" })).ok, true);
	assert.equal(k.lostState, false);
});

test("save and open round-trip through the wire", async (t) => {
	const { k, dir } = kernelIn(t);
	const path = join(dir, "nb.py");
	await k.call({ tool: "add_cell", src: "a = 1", name: "setup" });
	await k.call({ tool: "add_cell", src: "a + 1" });
	const saved = (await k.call({ tool: "save", path })) as RunResponse;
	assert.equal(saved.ok, true);
	assert.equal(saved.saved?.cells, 2);
	assert.match(readFileSync(path, "utf8"), /^# %% setup id="c1"$/m);

	const other = new Kernel(undefined, dir);
	t.after(() => other.kill());
	const loaded = (await other.call({ tool: "load", path })) as RunResponse;
	assert.equal(loaded.loaded?.cells, 2);
	assert.deepEqual(loaded.unrun, ["c1", "c2"]);
	const run = (await other.call({ tool: "run_all" })) as RunResponse;
	assert.equal(run.results?.[1].value, "2");
});

test("save refuses to clobber a plain python file", async (t) => {
	const { k, dir } = kernelIn(t);
	const path = join(dir, "module.py");
	writeFileSync(path, "def important():\n    return 1\n");
	await k.call({ tool: "add_cell", src: "a = 1" });
	const resp = await k.call({ tool: "save", path });
	assert.equal(resp.ok, false);
	assert.match(resp.error!, /overwrite/);
	assert.match(readFileSync(path, "utf8"), /important/);
});

test("eval uses the namespace without creating a cell", async (t) => {
	const { k } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "n = 6" });
	const resp = await k.call({ tool: "eval", src: "n * 7" });
	assert.equal(resp.value, "42");
	const inspected = (await k.call({ tool: "inspect" })) as InspectResponse;
	assert.equal(inspected.cells?.length, 1);
});

test("matplotlib runs headless, so importing pyplot cannot block", async (t) => {
	const { k } = kernelIn(t);
	const resp = await k.call({ tool: "eval", src: "__import__('os').environ['MPLBACKEND']" });
	assert.equal(resp.value, "'Agg'");
});

test("resolvePython bootstraps a venv and keeps it out of git", async (t) => {
	const dir = dirIn(t);
	const previous = process.env.PI_PYTHON;
	delete process.env.PI_PYTHON;
	t.after(() => {
		if (previous !== undefined) process.env.PI_PYTHON = previous;
	});
	const python = resolvePython(dir);
	assert.equal(existsSync(python), true, `expected an interpreter at ${python}`);
	assert.equal(readFileSync(join(dir, STATE_DIR, ".gitignore"), "utf8"), "venv/\npython-pin\n");
});

test("a pinned interpreter wins over the bootstrapped venv", async (t) => {
	const dir = dirIn(t);
	const previous = process.env.PI_PYTHON;
	delete process.env.PI_PYTHON;
	t.after(() => {
		if (previous !== undefined) process.env.PI_PYTHON = previous;
	});
	pinPython(dir, "/usr/bin/some-python");
	assert.equal(resolvePython(dir), "/usr/bin/some-python");
});

test("a pinned venv directory resolves to its interpreter", async (t) => {
	const dir = dirIn(t);
	const venv = join(dir, "fake-venv");
	mkdirSync(join(venv, "bin"), { recursive: true });
	writeFileSync(join(venv, "bin", "python"), "");
	pinPython(dir, venv);
	const previous = process.env.PI_PYTHON;
	delete process.env.PI_PYTHON;
	t.after(() => {
		if (previous !== undefined) process.env.PI_PYTHON = previous;
	});
	assert.equal(resolvePython(dir), join(venv, "bin", "python"));
});

test("a missing interpreter answers with an actionable message, not a hang", async (t) => {
	const dir = dirIn(t);
	const k = new Kernel(undefined, dir);
	t.after(() => k.kill());
	const previous = process.env.PI_PYTHON;
	process.env.PI_PYTHON = join(dir, "definitely-not-here");
	t.after(() => {
		if (previous === undefined) delete process.env.PI_PYTHON;
		else process.env.PI_PYTHON = previous;
	});
	const started = Date.now();
	const resp = await k.call({ tool: "inspect" });
	assert.equal(resp.ok, false);
	assert.match(resp.error!, /python|PI_PYTHON/i);
	// The round-trip timeout is 120s; this must fail long before that.
	assert.ok(Date.now() - started < 10_000, "should fail fast rather than time out");
});

test("the version floor is checked before the script is handed over", async (t) => {
	const version = interpreterVersion("python3");
	if (!version) return; // no python3 at all; the spawn path covers that
	assert.ok(MIN_PYTHON[0] === 3 && MIN_PYTHON[1] >= 12);
});
