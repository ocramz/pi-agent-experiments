// Project roots, import headers and closures, configuration, and finding the
// toolchain — the decisions made before any server exists.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { DEFAULTS, resolveConfig } from "../src/config.ts";
import { ImportGraph, parseImports, sourceDirs } from "../src/lean/imports.ts";
import { displayPath, findProjectRoot, isProjectRoot, requireLeanFile, resolveToolPath } from "../src/lean/project.ts";
import { locate, toolchainDirName, toolchainInstalled } from "../src/lean/toolchain.ts";
import { VERSION } from "../src/tools.ts";

function tmp(t: TestContext): string {
	const d = mkdtempSync(join(tmpdir(), "pi-lean4-proj-"));
	t.after(() => rmSync(d, { recursive: true, force: true }));
	return d;
}

function lakeProject(dir: string, lakefile = "lakefile.toml"): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "lean-toolchain"), "leanprover/lean4:v4.34.1\n");
	writeFileSync(join(dir, lakefile), "");
}

test("R1: a root needs lean-toolchain and a lakefile; the innermost wins", (t) => {
	const d = tmp(t);
	lakeProject(d);
	lakeProject(join(d, "inner"), "lakefile.lean");
	mkdirSync(join(d, "inner", "Src"), { recursive: true });
	writeFileSync(join(d, "inner", "Src", "A.lean"), "");
	assert.equal(findProjectRoot(join(d, "inner", "Src", "A.lean")), join(d, "inner"));
	mkdirSync(join(d, "toolchain-only"));
	writeFileSync(join(d, "toolchain-only", "lean-toolchain"), "x");
	assert.equal(isProjectRoot(join(d, "toolchain-only")), false);
	assert.equal(findProjectRoot(join(d, "toolchain-only", "X.lean")), d);
});

test("R2: a file under .lake/packages belongs to the project that pulled it in", (t) => {
	const d = tmp(t);
	lakeProject(d);
	const dep = join(d, ".lake", "packages", "mathlib");
	lakeProject(dep, "lakefile.lean");
	mkdirSync(join(dep, "Mathlib"), { recursive: true });
	writeFileSync(join(dep, "Mathlib", "X.lean"), "");
	assert.equal(findProjectRoot(join(dep, "Mathlib", "X.lean")), d);
});

test("R3: no project is a tool error that says how to make one", (t) => {
	const d = tmp(t);
	writeFileSync(join(d, "A.lean"), "");
	assert.equal(findProjectRoot(join(d, "A.lean")), null);
	assert.throws(() => requireLeanFile(join(d, "A.lean")), /not inside a Lake project.*lake new/s);
	assert.throws(() => requireLeanFile(join(d, "A.txt")), /not a \.lean file/);
	assert.throws(() => requireLeanFile(join(d, "Missing.lean")), /does not exist/);
});

test("R4: tool paths: @-prefix stripped, relative to cwd; shown relative to cwd", () => {
	assert.equal(resolveToolPath("@Foo/A.lean", "/w"), "/w/Foo/A.lean");
	assert.equal(resolveToolPath(" /abs/A.lean ", "/w"), "/abs/A.lean");
	assert.equal(displayPath("/w/Foo/A.lean", "/w"), join("Foo", "A.lean"));
	assert.equal(displayPath("/elsewhere/A.lean", "/w"), "/elsewhere/A.lean");
});

test("I1: imports, with module-system modifiers, comments and «quoted» names", () => {
	const text = "/- header /- nested -/ -/\nmodule\n-- c\npublic import A.B\nmeta import C\nimport all D.«E F»\nprivate import G\n\ntheorem x : True := trivial\nimport NotAnImport\n";
	assert.deepEqual(parseImports(text), ["A.B", "C", "D.E F", "G"]);
	assert.deepEqual(parseImports("prelude\nimport Init.Core\n"), ["Init.Core"]);
	assert.deepEqual(parseImports("def x := 1\n"), []);
});

test("I2: the closure fingerprint follows transitive in-project imports only", (t) => {
	const d = tmp(t);
	lakeProject(d);
	mkdirSync(join(d, "P"), { recursive: true });
	writeFileSync(join(d, "P", "A.lean"), "import P.B\nimport Mathlib\n");
	writeFileSync(join(d, "P", "B.lean"), "import P.C\n");
	writeFileSync(join(d, "P", "C.lean"), "def c := 1\n");
	writeFileSync(join(d, "P", "Unrelated.lean"), "def u := 1\n");
	const g = new ImportGraph(d);
	const a = readFileSync(join(d, "P", "A.lean"), "utf8");
	const f0 = g.closureFingerprint(a);
	assert.deepEqual(f0.modules, [join(d, "P", "B.lean"), join(d, "P", "C.lean")]);
	const later = new Date(Date.now() + 10_000);
	utimesSync(join(d, "P", "Unrelated.lean"), later, later);
	assert.equal(g.closureFingerprint(a).fingerprint, f0.fingerprint, "an unrelated file does not count");
	utimesSync(join(d, "P", "C.lean"), later, later);
	assert.notEqual(g.closureFingerprint(a).fingerprint, f0.fingerprint, "a transitive import does");
});

test("I3: lakefile srcDir is a source directory", (t) => {
	const d = tmp(t);
	lakeProject(d);
	writeFileSync(join(d, "lakefile.toml"), '[[lean_lib]]\nname = "X"\nsrcDir = "src"\n');
	assert.deepEqual(sourceDirs(d), [d, join(d, "src")]);
});

test("K1: config precedence: explicit, env, trusted settings, default", (t) => {
	const d = tmp(t);
	mkdirSync(join(d, ".pi"));
	writeFileSync(join(d, ".pi", "settings.json"), JSON.stringify({ lean4: { autoCheck: "always", maxOpenFiles: 2, offline: true, autoprove: { maxCycles: 9 } } }));
	const fromSettings = resolveConfig({ cwd: d, env: {} });
	assert.equal(fromSettings.autoCheck, "always");
	assert.equal(fromSettings.maxOpenFiles, 2);
	assert.equal(fromSettings.offline, true);
	assert.equal(fromSettings.autoprove.maxCycles, 9);
	assert.equal(fromSettings.autoprove.maxStuckCycles, DEFAULTS.autoprove.maxStuckCycles);
	const fromEnv = resolveConfig({ cwd: d, env: { PI_LEAN_AUTOCHECK: "off", PI_LEAN_OFFLINE: "0" } });
	assert.equal(fromEnv.autoCheck, "off");
	assert.equal(fromEnv.offline, false);
	assert.equal(resolveConfig({ cwd: d, env: { PI_LEAN_AUTOCHECK: "off" }, overrides: { autoCheck: "running" } }).autoCheck, "running");
});

test("K2: an untrusted project's settings are not read; junk falls through", (t) => {
	const d = tmp(t);
	mkdirSync(join(d, ".pi"));
	writeFileSync(join(d, ".pi", "settings.json"), JSON.stringify({ lean4: { lake: "/evil/lake" } }));
	assert.equal(resolveConfig({ env: {} }).lake, undefined, "no cwd = untrusted");
	assert.equal(resolveConfig({ cwd: d, env: {} }).lake, "/evil/lake");
	writeFileSync(join(d, ".pi", "settings.json"), "{ not json");
	assert.deepEqual(resolveConfig({ cwd: d, env: {} }), resolveConfig({ env: {} }));
	assert.equal(resolveConfig({ env: { PI_LEAN_MAX_OPEN_FILES: "lots", PI_LEAN_AUTOCHECK: "sometimes" } }).maxOpenFiles, DEFAULTS.maxOpenFiles);
});

test("T1: an explicit binary that does not exist is not found — no fallback", (t) => {
	const d = tmp(t);
	const fake = join(d, "lake");
	writeFileSync(fake, "#!/bin/sh\n");
	chmodSync(fake, 0o755);
	assert.deepEqual(locate("lake", { explicit: fake, env: {} }), { path: fake, source: "config" });
	assert.equal(locate("lake", { explicit: join(d, "nope"), env: { PATH: d } }).path, null);
	assert.deepEqual(locate("lake", { env: { PATH: `/nonexistent:${d}`, ELAN_HOME: "/nonexistent" } }), { path: fake, source: "PATH" });
	const bin = join(d, "pibin");
	mkdirSync(bin);
	writeFileSync(join(bin, "rg"), "#!/bin/sh\n");
	chmodSync(join(bin, "rg"), 0o755);
	assert.equal(locate("rg", { env: { PATH: "/nonexistent" }, extraDirs: [bin] }).path, join(bin, "rg"));
});

test("T2: elan's toolchain directory naming", (t) => {
	assert.equal(toolchainDirName("leanprover/lean4:v4.34.1"), "leanprover--lean4---v4.34.1");
	const d = tmp(t);
	mkdirSync(join(d, "toolchains", "leanprover--lean4---v4.34.1"), { recursive: true });
	assert.equal(toolchainInstalled("leanprover/lean4:v4.34.1", { ELAN_HOME: d }), true);
	assert.equal(toolchainInstalled("leanprover/lean4:v4.0.0", { ELAN_HOME: d }), false);
	assert.equal(toolchainInstalled(null, { ELAN_HOME: d }), true);
});

test("V0: the client version matches package.json", () => {
	const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
	assert.equal(VERSION, pkg.version);
});
