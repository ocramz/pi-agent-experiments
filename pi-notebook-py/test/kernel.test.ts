/**
 * The subprocess client, against a real Python.
 *
 * These spawn `py/protocol.py` for real: the JSON-lines framing, the
 * promise queue and the failure paths are exactly the parts a fake kernel
 * would stop testing. Each test gets its own temp dir, so the venv
 * bootstrap in `resolvePython` runs too.
 *
 * `PI_NOTEBOOK_HOME` points at a directory inside that temp dir, which is
 * what keeps the tier hermetic now that venvs live outside the project:
 * without it every case would build into the developer's real `~/.pi`.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import {
	FILE_RUN_MAX_CHARS,
	Kernel,
	MIN_PYTHON,
	NOTEBOOKS_DIR,
	STATE_DIR,
	dropVenv,
	envPlan,
	fileDigest,
	interpreterVersion,
	listNotebooks,
	nameError,
	notebookFile,
	pinPython,
	plannedInterpreter,
	projectSlug,
	resolvePython,
	runFile,
	venvDir,
} from "../src/kernel.ts";
import type { InspectResponse, RunResponse } from "../src/format.ts";

function dirIn(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-nb-unit-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A config env that keeps this case's venvs and pins inside its temp dir. */
function envIn(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return { ...process.env, PI_NOTEBOOK_HOME: join(dir, ".home"), ...extra };
}

function kernelIn(t: TestContext): { k: Kernel; dir: string } {
	const dir = dirIn(t);
	const k = new Kernel(undefined, dir, { env: envIn(dir) });
	t.after(() => k.kill());
	return { k, dir };
}

/** The same, minus PI_PYTHON, for the cases that are about resolution itself. */
function bareEnvIn(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = envIn(dir, extra);
	delete env.PI_PYTHON;
	return env;
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

test("every mutating response carries the cell count the checkpoint needs", async (t) => {
	const { k } = kernelIn(t);
	assert.equal(((await k.call({ tool: "add_cell", src: "a = 1" })) as RunResponse).cells, 1);
	assert.equal(((await k.call({ tool: "add_cell", src: "b = 2" })) as RunResponse).cells, 2);
	assert.equal(((await k.call({ tool: "delete_cell", id: "c1" })) as RunResponse).cells, 1);
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

test("a module written to the working directory is importable from a cell", async (t) => {
	const { k, dir } = kernelIn(t);
	writeFileSync(join(dir, "helper.py"), "def f():\n    return 1\n");
	const resp = await k.call({ tool: "eval", src: "import helper; helper.f()" });
	assert.equal(resp.ok, true);
	assert.equal(resp.value, "1");
});

test("restartProcess re-reads a module the notebook already imported", async (t) => {
	const { k, dir } = kernelIn(t);
	const helper = join(dir, "helper.py");
	writeFileSync(helper, "def f():\n    return 1\n");
	await k.call({ tool: "add_cell", src: "import helper" });
	await k.call({ tool: "add_cell", src: "helper.f()" });

	// The edit an agent makes between two runs. Resetting the namespace would
	// not touch sys.modules, so `helper` would still answer 1.
	//
	// The replacement is deliberately a different length. A source file
	// rewritten in the same second as its `__pycache__` entry and to exactly
	// the same size passes CPython's (mtime, size) check and loads stale
	// bytecode — everywhere, not just here (see semantics.md 3.9). Writing a
	// same-length body would test that, not this.
	writeFileSync(helper, "def f():\n    return 22\n");
	assert.equal((await k.restartProcess()).ok, true);

	const rerun = (await k.call({ tool: "run_all", restart: false })) as RunResponse;
	assert.equal(rerun.results?.[1].value, "22");
});

test("a restart keeps the cells and their ids, and is not a lost state", async (t) => {
	const { k } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "a = 1" });
	await k.call({ tool: "add_cell", src: "a + 1" });

	const resp = (await k.restartProcess()) as RunResponse;
	assert.equal(resp.ok, true);
	// The process was replaced deliberately, so the caller is not told it
	// lost anything it did not ask to lose.
	assert.equal(k.lostState, false);
	assert.deepEqual(resp.unrun, ["c1", "c2"]);

	const listed = (await k.call({ tool: "inspect" })) as InspectResponse;
	assert.deepEqual(
		listed.cells?.map((c) => c.id),
		["c1", "c2"],
	);
	// And the namespace really is gone.
	assert.equal((await k.call({ tool: "eval", src: "'a' in dir()" })).value, "False");
});

test("restarting a kernel that never spawned leaves its checkpoint alone", async (t) => {
	const { k, dir } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "a = 1" });
	await k.saveCheckpoint();
	const written = readFileSync(k.checkpoint, "utf8");

	// A new session on the same notebook has an empty in-process notebook and
	// a full file. Checkpointing before the kill would write the empty one
	// over the full one, which is the opposite of what a restart is for.
	const fresh = new Kernel(undefined, dir, { env: envIn(dir) });
	t.after(() => fresh.kill());
	assert.equal((await fresh.restartProcess()).ok, true);
	assert.equal(readFileSync(fresh.checkpoint, "utf8"), written);
});

test("save and open round-trip through the wire", async (t) => {
	const { k, dir } = kernelIn(t);
	const path = join(dir, "nb.py");
	await k.call({ tool: "add_cell", src: "a = 1" });
	await k.call({ tool: "add_cell", src: "a + 1" });
	const saved = (await k.call({ tool: "save", path })) as RunResponse;
	assert.equal(saved.ok, true);
	assert.equal(saved.saved?.cells, 2);
	assert.match(readFileSync(path, "utf8"), /^# %% id="c1"$/m);

	const other = new Kernel(undefined, dir, { env: envIn(dir) });
	t.after(() => other.kill());
	const loaded = (await other.call({ tool: "load", path })) as RunResponse;
	assert.equal(loaded.loaded?.cells, 2);
	assert.deepEqual(loaded.unrun, ["c1", "c2"]);
	const run = (await other.call({ tool: "run_all" })) as RunResponse;
	assert.equal(run.results?.[1].value, "2");
});

test("a save that names its notebook can be read back by name", async (t) => {
	const { k, dir } = kernelIn(t);
	const path = join(dir, "named.py");
	await k.call({ tool: "add_cell", src: "a = 1" });
	await k.call({ tool: "save", path, notebook: "sales" });
	const text = readFileSync(path, "utf8");
	assert.match(text, /^# ---\n# notebook: sales\n# ---$/m);
	// The fence is not a cell: the notebook still round-trips as one cell.
	const other = new Kernel(undefined, dir, { env: envIn(dir) });
	t.after(() => other.kill());
	assert.equal(((await other.call({ tool: "load", path })) as RunResponse).loaded?.cells, 1);
});

test("a checkpoint save does not become the notebook's remembered path", async (t) => {
	const { k, dir } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "a = 1" });
	await k.call({ tool: "save", path: join(dir, "explicit.py") });
	await k.call({ tool: "save", path: join(dir, "auto.py"), overwrite: true, remember: false });
	const resp = (await k.call({ tool: "inspect" })) as InspectResponse;
	assert.equal(resp.path, join(dir, "explicit.py"));
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

// ---- notebook names, and the paths they choose

test("a notebook name may not be a path, a traversal or empty", () => {
	assert.equal(nameError("sales"), null);
	assert.equal(nameError("sales-2024.v1_b"), null);
	for (const bad of ["", "..", "../etc", "a/b", "a\\b", ".hidden", "-lead", "a b"]) {
		assert.notEqual(nameError(bad), null, `expected ${JSON.stringify(bad)} to be refused`);
	}
});

test("two notebooks in one project get two venvs", (t) => {
	const dir = dirIn(t);
	const env = bareEnvIn(dir);
	const a = venvDir(dir, "a", { env });
	const b = venvDir(dir, "b", { env });
	assert.notEqual(a, b);
	assert.equal(a.endsWith(join(projectSlug(dir), "a")), true, a);
	assert.equal(b.endsWith(join(projectSlug(dir), "b")), true, b);
});

test("the same notebook name in two projects gets two venvs", (t) => {
	const one = dirIn(t);
	const two = dirIn(t);
	assert.notEqual(projectSlug(one), projectSlug(two));
	assert.notEqual(
		venvDir(one, "default", { env: bareEnvIn(one) }),
		venvDir(two, "default", { env: bareEnvIn(two) }),
	);
});

test("the checkpoint is inside the project, under .pi, and the venv is not", (t) => {
	const dir = dirIn(t);
	assert.equal(notebookFile(dir, "sales"), join(dir, STATE_DIR, NOTEBOOKS_DIR, "sales.py"));
	// The guarantee the whole layout exists for, asserted against the *default*
	// configuration rather than this file's redirected one: with nothing set,
	// nothing environment-shaped is under the project, so nothing can be swept
	// into a commit. Resolution only — this builds nothing.
	const env = { ...process.env };
	delete env.PI_NOTEBOOK_HOME;
	delete env.PI_NOTEBOOK_VENV_ROOT;
	const venv = venvDir(dir, "sales", { env });
	assert.equal(venv.startsWith(dir + "/"), false, venv);
	assert.equal(venv.startsWith(homedir() + "/"), true, venv);
});

test("resolvePython builds the notebook's venv, outside the working tree", async (t) => {
	const dir = dirIn(t);
	const env = bareEnvIn(dir);
	const python = await resolvePython(dir, "default", { env });
	assert.equal(existsSync(python), true, `expected an interpreter at ${python}`);
	assert.equal(python.startsWith(join(dir, ".home")), true, python);
	// Nothing was written into the project at all.
	assert.equal(existsSync(join(dir, STATE_DIR)), false);
	assert.equal(existsSync(join(dir, ".notebook")), false);
});

test("a venvRoot pointed inside the repo is excluded from git instead", async (t) => {
	const dir = dirIn(t);
	const { spawnSync } = await import("node:child_process");
	spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
	const env = bareEnvIn(dir, { PI_NOTEBOOK_VENV_ROOT: join(dir, "envs") });
	await resolvePython(dir, "default", { env });
	const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
	assert.match(exclude, /^\/envs\/$/m);
	const ignored = spawnSync("git", ["check-ignore", "envs"], { cwd: dir });
	assert.equal(ignored.status, 0, "the venv root should be ignored after the write");
});

test("a pinned interpreter wins over the bootstrapped venv", (t) => {
	const dir = dirIn(t);
	const env = bareEnvIn(dir);
	pinPython(dir, "default", "/usr/bin/some-python", env);
	assert.equal(plannedInterpreter(dir, "default", { env }).python, "/usr/bin/some-python");
	// And only that notebook: the pin is per notebook, not per project.
	assert.equal(plannedInterpreter(dir, "other", { env }).source, "venv");
});

test("a pinned venv directory resolves to its interpreter", (t) => {
	const dir = dirIn(t);
	const env = bareEnvIn(dir);
	const venv = join(dir, "fake-venv");
	mkdirSync(join(venv, "bin"), { recursive: true });
	writeFileSync(join(venv, "bin", "python"), "");
	pinPython(dir, "default", venv, env);
	assert.equal(plannedInterpreter(dir, "default", { env }).python, join(venv, "bin", "python"));
});

test("a shareable pin in settings.json resolves against the project", (t) => {
	const dir = dirIn(t);
	const env = bareEnvIn(dir);
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(
		join(dir, ".pi", "settings.json"),
		JSON.stringify({ notebookPy: { python: { sales: "./.venv" } } }),
	);
	const planned = plannedInterpreter(dir, "sales", { cwd: dir, env });
	assert.equal(planned.source, "settings");
	assert.equal(planned.python, join(dir, ".venv"));
	// A machine-local pin still outranks it — it names a real interpreter here.
	pinPython(dir, "sales", "/usr/bin/some-python", env);
	assert.equal(plannedInterpreter(dir, "sales", { cwd: dir, env }).source, "pin");
});

test("listNotebooks finds checkpoints and venvs, and drop removes only the venv", async (t) => {
	const dir = dirIn(t);
	const env = bareEnvIn(dir);
	const file = notebookFile(dir, "sales");
	mkdirSync(join(dir, STATE_DIR, NOTEBOOKS_DIR), { recursive: true });
	writeFileSync(file, "# %%\na = 1\n");
	await resolvePython(dir, "scratch", { env });

	const found = listNotebooks(dir, { env });
	assert.deepEqual(
		found.map((n) => [n.name, n.hasFile, n.hasVenv]),
		[
			["sales", true, false],
			["scratch", false, true],
		],
	);

	assert.notEqual(dropVenv(dir, "scratch", { env }), null);
	assert.equal(dropVenv(dir, "scratch", { env }), null, "dropping twice is not an error");
	assert.equal(existsSync(file), true, "drop must never touch the checkpoint");
});

test("a pin does not hide the venv it stranded, or make it undroppable", async (t) => {
	const dir = dirIn(t);
	const env = bareEnvIn(dir);
	await resolvePython(dir, "scratch", { env });

	// Pinning is what strands a venv: the interpreter changes, the built
	// environment stays on disk, and it is now pure disk with nothing running
	// it. Reporting it only while nothing overrode it would hide exactly the
	// environments worth reclaiming.
	pinPython(dir, "scratch", "/usr/bin/some-python", env);
	const [scratch] = listNotebooks(dir, { env });
	assert.equal(scratch.source, "pin", "the pin still decides what runs");
	assert.equal(scratch.hasVenv, true, "but the stranded venv is still reported");
	assert.equal(scratch.venv, venvDir(dir, "scratch", { env }));

	const removed = dropVenv(dir, "scratch", { env });
	assert.equal(removed, venvDir(dir, "scratch", { env }), "and it can still be removed");
	assert.equal(existsSync(removed as string), false);
	// Never the interpreter the pin names — drop owns the venv, not what runs.
	assert.equal(plannedInterpreter(dir, "scratch", { env }).python, "/usr/bin/some-python");
});

test("switching notebooks kills the kernel and takes the namespace with it", async (t) => {
	const { k } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "carried = 1" });
	assert.equal(k.useNotebook("other"), null);
	assert.equal(k.notebook, "other");
	const resp = (await k.call({ tool: "inspect" })) as InspectResponse;
	assert.deepEqual(resp.cells, []);
	// A deliberate switch is not a crash, so it is not reported as lost state —
	// the extension says what happened instead.
	assert.equal(k.lostState, false);
	assert.equal((await k.call({ tool: "eval", src: "carried" })).ok, false);
});

test("switching to an invalid name is refused without disturbing the kernel", async (t) => {
	const { k } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "kept = 1" });
	assert.match(k.useNotebook("../escape")!, /invalid notebook name/);
	assert.equal(k.notebook, "default");
	assert.equal((await k.call({ tool: "eval", src: "kept" })).value, "1");
});

test("the checkpoint path follows the notebook", (t) => {
	const dir = dirIn(t);
	const k = new Kernel(undefined, dir, { env: envIn(dir) });
	t.after(() => k.kill());
	assert.equal(k.checkpoint, join(dir, STATE_DIR, NOTEBOOKS_DIR, "default.py"));
	k.useNotebook("sales");
	assert.equal(k.checkpoint, join(dir, STATE_DIR, NOTEBOOKS_DIR, "sales.py"));
});

test("the default notebook can be set per project", (t) => {
	const dir = dirIn(t);
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(
		join(dir, ".pi", "settings.json"),
		JSON.stringify({ notebookPy: { default: "sales" } }),
	);
	const k = new Kernel(undefined, dir, { env: bareEnvIn(dir) });
	t.after(() => k.kill());
	assert.equal(k.notebook, "sales");
});

test("a missing interpreter answers with an actionable message, not a hang", async (t) => {
	const dir = dirIn(t);
	const k = new Kernel(undefined, dir, {
		env: envIn(dir, { PI_PYTHON: join(dir, "definitely-not-here") }),
	});
	t.after(() => k.kill());
	const started = Date.now();
	const resp = await k.call({ tool: "inspect" });
	assert.equal(resp.ok, false);
	assert.match(resp.error!, /python|PI_PYTHON/i);
	// The round-trip timeout is 120s; this must fail long before that.
	assert.ok(Date.now() - started < 10_000, "should fail fast rather than time out");
});

test("the version floor is checked before the script is handed over", async () => {
	const version = await interpreterVersion("python3");
	if (!version) return; // no python3 at all; the spawn path covers that
	assert.ok(MIN_PYTHON[0] === 3 && MIN_PYTHON[1] >= 12);
});

// ---- reporting: which interpreter this is, and whether the file still matches

test("env reports the interpreter that is really running, not the planned one", async (t) => {
	const { k } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "a = 1" }); // force a spawn
	const resp = await k.call({ tool: "env" });
	assert.equal(resp.ok, true);
	// `sys.executable` from the live child is the ground truth: resolvePython
	// falls back to a base interpreter when a venv cannot be built, and only
	// the child knows which one it ended up as.
	assert.equal(realpathSync(resp.executable as string), realpathSync(k.interpreter!));
	assert.match(resp.version as string, /^3\.\d+\.\d+$/);
	assert.ok(Array.isArray(resp.packages));
	// A report is not a mutation, so it carries no staleness lists.
	assert.equal("stale" in resp, false);
});

test("env can be asked for the interpreter without the lock", async (t) => {
	const { k } = kernelIn(t);
	const resp = await k.call({ tool: "env", lock: false });
	assert.equal(resp.ok, true);
	assert.equal("packages" in resp, false);
	assert.ok(resp.executable);
});

test("envPlan flags an interpreter that is not the one the rules chose", (t) => {
	const dir = dirIn(t);
	const env = bareEnvIn(dir);
	const planned = plannedInterpreter(dir, "sales", { env });
	assert.equal(envPlan(dir, "sales", planned.python, { env }).mismatch, false);
	// The case that matters: a venv that could not be built, so the kernel is
	// running something else and `source` describes an environment nothing is in.
	const strayed = envPlan(dir, "sales", "/usr/bin/python3", { env });
	assert.equal(strayed.mismatch, true);
	assert.equal(strayed.source, "venv");
	// With nothing running there is nothing to compare against, and no claim.
	assert.equal(envPlan(dir, "sales", undefined, { env }).mismatch, false);
});

test("the digest matches the checkpoint the client writes", async (t) => {
	const { k } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "a = 1" });
	await k.saveCheckpoint();
	const resp = await k.call({ tool: "digest", notebook: k.notebook });
	const file = fileDigest(k.checkpoint);
	assert.equal(resp.sha256, file?.sha256);
	assert.equal(resp.bytes, file?.bytes);
	assert.equal(resp.cells, 1);
});

test("editing the checkpoint by hand is what divergence looks like", async (t) => {
	const { k } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "a = 1" });
	await k.saveCheckpoint();
	// The file is ordinary source and is meant to be edited; this is the case
	// the report exists for.
	writeFileSync(k.checkpoint, readFileSync(k.checkpoint, "utf8") + '\n# %% id="c9"\nb = 2\n');
	const resp = await k.call({ tool: "digest", notebook: k.notebook });
	assert.notEqual(resp.sha256, fileDigest(k.checkpoint)?.sha256);
});

test("fileDigest answers null rather than throwing for a file that is not there", (t) => {
	assert.equal(fileDigest(join(dirIn(t), "nope.py")), null);
});

test("running is false until there is a child, and false again after a kill", async (t) => {
	// This is what keeps `digest` from building a venv as a side effect of
	// being asked whether a hash matches.
	const { k } = kernelIn(t);
	assert.equal(k.running, false);
	await k.call({ tool: "inspect" });
	assert.equal(k.running, true);
	k.kill();
	assert.equal(k.running, false);
});

// ---- running a .py as a fresh process

/** A script in the kernel's own directory, so a relative path works too. */
function script(dir: string, name: string, body: string): string {
	const path = join(dir, name);
	writeFileSync(path, body);
	return path;
}

test("a file run reports stdout and the exit status", async (t) => {
	const { k, dir } = kernelIn(t);
	script(dir, "ok.py", "print('hello')\n");
	const run = await runFile(await k.pythonFor(), "ok.py", [], dir);
	assert.equal(run.error, undefined);
	assert.equal(run.code, 0);
	assert.match(run.stdout, /hello/);
	assert.equal(run.timedOut, false);
});

test("a script that raises is a non-zero exit and a traceback, not a throw", async (t) => {
	const { k, dir } = kernelIn(t);
	script(dir, "boom.py", "raise KeyError('total')\n");
	const run = await runFile(await k.pythonFor(), "boom.py", [], dir);
	assert.equal(run.code, 1);
	assert.match(run.stderr, /KeyError/);
});

test("args reach the script as sys.argv[1:]", async (t) => {
	const { k, dir } = kernelIn(t);
	script(dir, "argv.py", "import sys; print('|'.join(sys.argv[1:]))\n");
	const run = await runFile(await k.pythonFor(), "argv.py", ["--n", "3"], dir);
	assert.match(run.stdout, /^--n\|3$/m);
});

test("a missing path is a message rather than an exception", async (t) => {
	const { k, dir } = kernelIn(t);
	const run = await runFile(await k.pythonFor(), "nope.py", [], dir);
	assert.match(run.error!, /no such file/);
	assert.equal(run.code, null);
	// A directory parses as a path and would otherwise hand python a
	// confusing IsADirectoryError from somewhere else entirely.
	assert.match((await runFile(await k.pythonFor(), ".", [], dir)).error!, /directory/);
});

test("a script that hangs is killed on its own budget, and says so", async (t) => {
	const { k, dir } = kernelIn(t);
	script(dir, "hang.py", "import time\nwhile True: time.sleep(1)\n");
	const run = await runFile(await k.pythonFor(), "hang.py", [], dir, 1_000);
	assert.equal(run.timedOut, true);
	// The kernel is untouched: the round-trip timer would have killed it and
	// taken the namespace, which is the whole reason this runs outside it.
	assert.equal((await k.call({ tool: "inspect" })).ok, true);
});

test("a chatty script keeps its tail and says how much was dropped", async (t) => {
	const { k, dir } = kernelIn(t);
	// The last line is what a caller wants; the first hundred thousand are
	// what would otherwise fill the context window.
	script(dir, "loud.py", "for i in range(200_000): print(i)\nprint('LAST')\n");
	const run = await runFile(await k.pythonFor(), "loud.py", [], dir);
	assert.ok(run.stdoutDropped > 0, "expected output to be truncated");
	assert.ok(run.stdout.length <= FILE_RUN_MAX_CHARS);
	assert.match(run.stdout, /LAST/);
	assert.equal(/^0$/m.test(run.stdout), false, "the head should be the part that went");
});

test("a file run leaves the notebook namespace alone", async (t) => {
	// The contract the op is named for. Same interpreter, same working
	// directory, and none of it reaches the cells.
	const { k, dir } = kernelIn(t);
	await k.call({ tool: "add_cell", src: "total = 20" });
	script(dir, "clobber.py", "total = 999\nprint('ran')\n");
	const run = await runFile(await k.pythonFor(), "clobber.py", [], dir);
	assert.equal(run.code, 0);
	const after = (await k.call({ tool: "eval", src: "total" })) as RunResponse;
	assert.equal((after as { value?: string }).value, "20");
	const inspected = (await k.call({ tool: "inspect" })) as InspectResponse;
	assert.equal(inspected.cells?.length, 1);
	assert.deepEqual(inspected.stale, []);
});

test("a file run uses the notebook's own interpreter", async (t) => {
	const { k, dir } = kernelIn(t);
	await k.call({ tool: "inspect" }); // spawn, so there is a live interpreter
	script(dir, "which.py", "import sys; print(sys.executable)\n");
	const run = await runFile(await k.pythonFor(), "which.py", [], dir);
	assert.equal(realpathSync(run.stdout.trim()), realpathSync(k.interpreter!));
});
