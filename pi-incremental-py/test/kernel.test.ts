import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Kernel, MIN_PYTHON, interpreterVersion, resolvePython } from "../src/kernel.ts";
import { formatEval, formatInspect, formatResults } from "../src/format.ts";

// These tests drive the real Python kernel (stdlib-only python3, venv module).

/** A Kernel scoped to a fresh project dir, so venv creation is exercised. */
function kernelIn(t: TestContext): { k: Kernel; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-inc-unit-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return { k: new Kernel(undefined, dir), dir };
}

test("resolvePython creates a project-scoped venv on first use", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-inc-venv-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	delete process.env.PI_PYTHON;
	const py = resolvePython(dir);
	assert.ok(py.includes(join(".incremental", "venv")), `got ${py}`);
	assert.equal(resolvePython(dir), py); // idempotent
});

test("kernel round trip: add, inspect, modify by id", async (t) => {
	const { k } = kernelIn(t);
	try {
		const add = await k.call({ tool: "add_cell", src: "x = 1", name: "first" });
		assert.equal(add.ok, true);
		const id = add.id as string;
		assert.match(id, /^[a-z2-7]{6}$/);

		const inspect = await k.call({ tool: "inspect" });
		assert.equal(inspect.ok, true);

		const set = await k.call({ tool: "set_cell", id, src: "x = 2" });
		assert.equal(set.ok, true);
		assert.deepEqual(set.globals, { x: "2" });
	} finally {
		k.kill();
	}
});

test("calls are serialised even when issued concurrently", async (t) => {
	const { k } = kernelIn(t);
	try {
		const [a, b, c] = await Promise.all([
			k.call({ tool: "add_cell", src: "a = 1" }),
			k.call({ tool: "add_cell", src: "b = 2" }),
			k.call({ tool: "add_cell", src: "c = 3" }),
		]);
		assert.ok(a.ok && b.ok && c.ok);
		const ids = new Set([a.id, b.id, c.id]);
		assert.equal(ids.size, 3); // no id collision under interleaving
	} finally {
		k.kill();
	}
});

test("kernel crash: next call respawns and flags lost state", async (t) => {
	const { k } = kernelIn(t);
	try {
		await k.call({ tool: "add_cell", src: "x = 1" });
		k.kill();
		// give the process a tick to actually exit
		await new Promise((r) => setTimeout(r, 100));
		const resp = await k.call({ tool: "inspect" });
		assert.equal(resp.ok, true);
		assert.equal(k.lostState, true);
		k.lostState = false;
	} finally {
		k.kill();
	}
});

// A machine with no usable interpreter is not exotic — resolvePython falls
// through to a bare "python3" when it finds nothing to build a venv from, and
// the pinned container image has no Python at all. An ENOENT spawn emits
// 'error' and never 'exit', so unhandled it is an uncaught exception that ends
// the pi session, and the round trip would hang for the full timeout.
test("a missing interpreter answers, promptly and by name", async (t) => {
	const previous = process.env.PI_PYTHON;
	process.env.PI_PYTHON = "/nonexistent/python";
	t.after(() => {
		if (previous === undefined) delete process.env.PI_PYTHON;
		else process.env.PI_PYTHON = previous;
	});

	const { k } = kernelIn(t);
	try {
		const started = Date.now();
		const resp = await k.call({ tool: "inspect" });
		assert.equal(resp.ok, false);
		assert.match(String(resp.error), /python not found: \/nonexistent\/python/);
		// The way out has to be in the message: the agent sees only this text.
		assert.match(String(resp.error), /py-python|PI_PYTHON/);
		assert.ok(Date.now() - started < 5_000, "should not wait out the round-trip timeout");

		// The failed handle keeps exitCode === null, so a second call must not
		// be handed the same dead child and left waiting on a listener that
		// will never fire again.
		const again = await k.call({ tool: "inspect" });
		assert.equal(again.ok, false);
		assert.match(String(again.error), /python not found/);
	} finally {
		k.kill();
	}
});

// The floor cannot be enforced from inside the Python: py/protocol.py uses
// `match`, so on a pre-3.10 interpreter the module fails to parse and a
// sys.version_info guard never runs. All the agent would see is a SyntaxError
// on stderr and a kernel that exited. A stub interpreter stands in for the
// conda/system 3.9 that is genuinely first on PATH on many machines.
test("an interpreter below the floor is named, not left to SyntaxError", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-inc-old-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const stub = join(dir, "python3.9");
	writeFileSync(stub, "#!/bin/sh\necho 3.9\n", { mode: 0o755 });

	const previous = process.env.PI_PYTHON;
	process.env.PI_PYTHON = stub;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_PYTHON;
		else process.env.PI_PYTHON = previous;
	});

	assert.deepEqual(interpreterVersion(stub), [3, 9]);
	assert.equal(interpreterVersion(join(dir, "nope")), null);

	const k = new Kernel(undefined, dir);
	try {
		const resp = await k.call({ tool: "inspect" });
		assert.equal(resp.ok, false);
		assert.match(String(resp.error), /python 3\.9 .* is too old/);
		assert.match(String(resp.error), new RegExp(`${MIN_PYTHON[0]}\\.${MIN_PYTHON[1]}\\+`));
	} finally {
		k.kill();
	}
});

test("eval leaves no cell behind", async (t) => {
	const { k } = kernelIn(t);
	try {
		await k.call({ tool: "add_cell", src: "rows = [1, 2, 3]" });
		const resp = await k.call({ tool: "eval", src: "len(rows)" });
		assert.equal(resp.ok, true);
		assert.equal(resp.value, "3");
		const inspect = (await k.call({ tool: "inspect" })) as unknown as {
			cells: unknown[];
		};
		assert.equal(inspect.cells.length, 1);
	} finally {
		k.kill();
	}
});

test("cell stdout is captured, the wire stays clean", async (t) => {
	const { k } = kernelIn(t);
	try {
		const resp = await k.call({ tool: "add_cell", src: "print('noise')\n42" });
		assert.equal(resp.ok, true);
		const results = resp.results as { output: string }[];
		assert.match(results[0].output, /noise/);
	} finally {
		k.kill();
	}
});

// ── formatting ──────────────────────────────────────────────────

test("formatResults collapses cached and shows failure tails", () => {
	const text = formatResults({
		ok: true,
		id: "abc123",
		results: [
			{ cell: "abc123", status: "ran", seconds: 0.012, value: "5" },
			{ cell: "def456", status: "cached", seconds: 0, value: "x" },
			{ cell: "ghi789", status: "cached", seconds: 0, value: "y" },
		],
		pending: [],
		failing: [],
		globals: { x: "5" },
	});
	assert.match(text, /id: abc123/);
	assert.match(text, /\* abc123 ran 12\.0ms {2}5/);
	assert.match(text, /2 cells cached/);
	assert.doesNotMatch(text, /pending:/);
});

test("formatResults surfaces errors and output", () => {
	const text = formatResults({
		ok: true,
		results: [
			{
				cell: "abc123",
				status: "error",
				seconds: 0.001,
				error: "NameError: nope",
				output: "partial print\n",
			},
		],
		failing: ["abc123"],
		pending: ["def456"],
	});
	assert.match(text, /! abc123 error .*NameError: nope/);
	assert.match(text, /\| partial print/);
	assert.match(text, /failing: abc123/);
	assert.match(text, /pending: def456/);
});

test("formatInspect renders the graph with labels and flags", () => {
	const text = formatInspect({
		ok: true,
		cells: [
			{ id: "abc123", name: "load", defines: ["rows"], depends_on: [], stateful: false, failing: false },
			{ id: "def456", name: null, defines: ["n"], depends_on: ["abc123"], stateful: true, failing: true },
		],
		globals: { rows: "list(3)" },
		pending: ["def456"],
	});
	assert.match(text, /1 cell|2 cells/);
	assert.match(text, /abc123 \(load\): defines \[rows\]/);
	assert.match(text, /def456: defines \[n\] <- abc123 {2}stateful FAILING/);
	assert.match(text, /globals: rows=list\(3\)/);
});

test("formatEval", () => {
	assert.equal(formatEval({ ok: true, value: "3" }), "3");
	assert.match(formatEval({ ok: false, error: "NameError: x" }), /Error: NameError/);
});
