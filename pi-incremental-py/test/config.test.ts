import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { resolveContextFilter, resolveMemoBudget } from "../src/config.ts";

/** A project dir, optionally carrying a `.pi/settings.json`. */
function projectIn(t: TestContext, settings?: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-inc-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	if (settings !== undefined) {
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(
			join(dir, ".pi", "settings.json"),
			typeof settings === "string" ? settings : JSON.stringify(settings),
		);
	}
	return dir;
}

test("no memo budget anywhere leaves the kernel's own default alone", (t) => {
	const dir = projectIn(t);
	assert.equal(resolveMemoBudget({ cwd: dir, env: {} }), undefined);
});

test("settings.json sets the memo budget, and the environment outranks it", (t) => {
	const dir = projectIn(t, { incrementalPy: { memoBudgetBytes: 1024 } });
	assert.equal(resolveMemoBudget({ cwd: dir, env: {} }), 1024);
	assert.equal(resolveMemoBudget({ cwd: dir, env: { PI_PY_MEMO_BUDGET: "64" } }), 64);
});

test("zero is a budget, not an absence — it switches the memo off", (t) => {
	const dir = projectIn(t, { incrementalPy: { memoBudgetBytes: 0 } });
	assert.equal(resolveMemoBudget({ cwd: dir, env: {} }), 0);
});

test("nonsense in the environment falls through rather than winning", (t) => {
	const dir = projectIn(t, { incrementalPy: { memoBudgetBytes: 1024 } });
	assert.equal(resolveMemoBudget({ cwd: dir, env: { PI_PY_MEMO_BUDGET: "lots" } }), 1024);
	assert.equal(resolveMemoBudget({ cwd: dir, env: { PI_PY_MEMO_BUDGET: "-1" } }), 1024);
});

test("the filter is on when nothing says otherwise", (t) => {
	const dir = projectIn(t);
	assert.equal(resolveContextFilter({ cwd: dir, env: {} }), true);
});

test("settings.json turns it off", (t) => {
	const dir = projectIn(t, { incrementalPy: { contextFilter: false } });
	assert.equal(resolveContextFilter({ cwd: dir, env: {} }), false);
});

test("an unrelated settings.json leaves the default alone", (t) => {
	const dir = projectIn(t, { packages: ["../pi-incremental-py"] });
	assert.equal(resolveContextFilter({ cwd: dir, env: {} }), true);
});

test("the environment beats settings.json, in both directions", (t) => {
	const off = projectIn(t, { incrementalPy: { contextFilter: false } });
	assert.equal(resolveContextFilter({ cwd: off, env: { PI_PY_CONTEXT_FILTER: "1" } }), true);

	const on = projectIn(t, { incrementalPy: { contextFilter: true } });
	assert.equal(resolveContextFilter({ cwd: on, env: { PI_PY_CONTEXT_FILTER: "0" } }), false);
});

test("the off-switch spellings", (t) => {
	const dir = projectIn(t);
	for (const v of ["0", "false", "FALSE", "no", "off", " Off "]) {
		assert.equal(resolveContextFilter({ cwd: dir, env: { PI_PY_CONTEXT_FILTER: v } }), false, v);
	}
	for (const v of ["1", "true", "yes", "on"]) {
		assert.equal(resolveContextFilter({ cwd: dir, env: { PI_PY_CONTEXT_FILTER: v } }), true, v);
	}
});

test("an exported-but-blank variable falls through instead of winning", (t) => {
	const dir = projectIn(t, { incrementalPy: { contextFilter: false } });
	assert.equal(resolveContextFilter({ cwd: dir, env: { PI_PY_CONTEXT_FILTER: "" } }), false);
	assert.equal(resolveContextFilter({ cwd: dir, env: { PI_PY_CONTEXT_FILTER: "  " } }), false);
});

test("explicit overrides beat both", (t) => {
	const dir = projectIn(t, { incrementalPy: { contextFilter: true } });
	const env = { PI_PY_CONTEXT_FILTER: "1" };
	assert.equal(resolveContextFilter({ cwd: dir, env, overrides: { contextFilter: false } }), false);
});

test("a malformed settings.json falls back rather than throwing", (t) => {
	const dir = projectIn(t, "{ this is not json");
	assert.equal(resolveContextFilter({ cwd: dir, env: {} }), true);
});

test("no cwd means the project-local read is skipped entirely", (t) => {
	// What an untrusted project gets: its settings.json is never opened.
	const dir = projectIn(t, { incrementalPy: { contextFilter: false } });
	assert.equal(resolveContextFilter({ cwd: undefined, env: {} }), true);
	assert.equal(resolveContextFilter({ cwd: dir, env: {} }), false); // ...but it is readable
});
