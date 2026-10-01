// The setup check: every finding, from an isolated fake machine — HOME, PATH,
// ELAN_HOME and the project are all built under mkdtemp, so what this host has
// installed never leaks in.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { DEFAULTS, type ResolvedConfig } from "../src/config.ts";
import {
	type PreflightReport,
	asError,
	candidateRoots,
	checkProject,
	fingerprintFindings,
	formatForAgent,
	formatForUser,
	parseLeanVersion,
	preflight,
	statusBadge,
} from "../src/lean/preflight.ts";

const TC = "leanprover/lean4:v4.34.1";

interface Machine {
	home: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	bin(dir: string, name: string): string;
	file(rel: string, text: string): void;
	run(cfg?: Partial<ResolvedConfig>, opts?: { trusted?: boolean; cwd?: string; platform?: NodeJS.Platform }): PreflightReport;
}

/** A machine with nothing installed. `lean: true` adds elan, lake on PATH and the toolchain; `rg: true` adds ripgrep. */
function machine(t: TestContext, opts: { project?: boolean; lean?: boolean; rg?: boolean; toolchain?: string } = {}): Machine {
	const home = mkdtempSync(join(tmpdir(), "pi-lean4-preflight-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const cwd = join(home, "proj");
	mkdirSync(cwd);
	const pathDirs: string[] = [];
	const bin = (dir: string, name: string) => {
		mkdirSync(dir, { recursive: true });
		const p = join(dir, name);
		writeFileSync(p, "#!/bin/sh\n");
		chmodSync(p, 0o755);
		return p;
	};
	if (opts.lean) {
		const eb = join(home, ".elan", "bin");
		bin(eb, "elan");
		bin(eb, "lake");
		mkdirSync(join(home, ".elan", "toolchains", "leanprover--lean4---v4.34.1"), { recursive: true });
		pathDirs.push(eb);
	}
	if (opts.rg) pathDirs.push(join(home, "rgbin")), bin(join(home, "rgbin"), "rg");
	if (opts.project ?? true) {
		writeFileSync(join(cwd, "lean-toolchain"), `${opts.toolchain ?? TC}\n`);
		writeFileSync(join(cwd, "lakefile.toml"), 'name = "proj"\n');
	}
	const env: NodeJS.ProcessEnv = { HOME: home, PATH: pathDirs.join(":") };
	return {
		home,
		cwd,
		env,
		bin,
		file(rel, text) {
			mkdirSync(join(cwd, rel, ".."), { recursive: true });
			writeFileSync(join(cwd, rel), text);
		},
		run(cfg = {}, o = {}) {
			return preflight({ cwd: o.cwd ?? cwd, cfg: { ...DEFAULTS, ...cfg }, trusted: o.trusted ?? true, env, rgDirs: [], platform: o.platform ?? "linux" });
		},
	};
}

const ids = (r: PreflightReport) => r.findings.map((f) => f.id);

test("PF1: a complete setup reports nothing", (t) => {
	const m = machine(t, { lean: true, rg: true });
	const r = m.run();
	assert.deepEqual(r.findings, []);
	assert.equal(formatForUser(r), "pi-lean4 setup: ok");
	assert.equal(statusBadge(r), undefined);
	assert.ok(r.lake.path?.endsWith("/.elan/bin/lake"));
});

test("PF2: outside any Lean project, nothing is checked or said", (t) => {
	const m = machine(t, { project: false });
	assert.deepEqual(m.run().findings, [], "a non-Lean session must not hear about Lean");
});

test("PF3: .lean files without a Lake project: say what a project needs and how to make one", (t) => {
	const m = machine(t, { project: false });
	m.file("Scratch.lean", "theorem x : True := trivial\n");
	const r = m.run();
	assert.deepEqual(ids(r), ["not-a-project"]);
	assert.match(r.findings[0].problem, /needs both lean-toolchain and lakefile/);
	assert.match(r.findings[0].fix, /lake init <name>/);
	m.file("lean-toolchain", TC);
	assert.match(m.run().findings[0].problem, /it has lean-toolchain but/);
});

test("PF4: no lake anywhere: an error with the elan install command", (t) => {
	const m = machine(t, { rg: true });
	const r = m.run();
	assert.deepEqual(ids(r), ["lake-missing"]);
	const f = r.findings[0];
	assert.equal(f.severity, "error");
	assert.match(f.fix, /curl https:\/\/elan\.lean-lang\.org\/elan-init\.sh -sSf \| sh -s -- -y/);
	assert.match(f.fix, /without restarting pi/);
	assert.match(statusBadge(r) ?? "", /lake not found/);
	assert.match(asError(f), /^lake \(Lean's build tool\) was not found.*Install Lean through elan/s);
});

test("PF5: a configured lake that does not exist names the setting, not the installer", (t) => {
	const m = machine(t, { lean: true, rg: true });
	const r = m.run({ lake: join(m.home, "nope", "lake") });
	assert.deepEqual(ids(r), ["lake-config-wrong"]);
	assert.match(r.findings[0].problem, /PI_LEAN_LAKE or the lean4\.lake setting/);
	assert.match(r.findings[0].fix, /unset it/);
});

test("PF6: lake found in ~/.elan/bin but not on PATH: tools work, bash commands will not", (t) => {
	const m = machine(t, { lean: true, rg: true });
	m.env.PATH = join(m.home, "rgbin");
	const r = m.run();
	assert.deepEqual(ids(r), ["lake-not-on-path"]);
	assert.equal(r.findings[0].severity, "warning");
	assert.match(r.findings[0].impact, /command not found/);
	assert.match(r.findings[0].fix, /export PATH=".*\.elan\/bin:\$PATH"/);
});

test("PF7: the pinned toolchain is not installed: a warning online, an error offline — with the elan command", (t) => {
	const m = machine(t, { lean: true, rg: true, toolchain: "leanprover/lean4:v4.30.0" });
	const online = m.run();
	assert.deepEqual(ids(online), ["toolchain-missing"]);
	assert.equal(online.findings[0].severity, "warning");
	assert.match(online.findings[0].fix, /elan toolchain install leanprover\/lean4:v4\.30\.0/);
	const offline = m.run({ offline: true });
	assert.deepEqual(ids(offline), ["toolchain-offline"]);
	assert.equal(offline.findings[0].severity, "error");
	assert.match(offline.findings[0].fix, /PI_LEAN_OFFLINE/);
});

test("PF8: a toolchain older than the supported floor is flagged", (t) => {
	const m = machine(t, { lean: true, rg: true, toolchain: "leanprover/lean4:v4.20.0" });
	mkdirSync(join(m.home, ".elan", "toolchains", "leanprover--lean4---v4.20.0"), { recursive: true });
	const r = m.run();
	assert.deepEqual(ids(r), ["toolchain-old"]);
	assert.match(r.findings[0].problem, /Lean 4\.20\.0; pi-lean4 needs Lean 4\.24\.0 or newer/);
	assert.deepEqual(parseLeanVersion("leanprover/lean4:v4.25.0-rc1"), [4, 25, 0]);
	assert.equal(parseLeanVersion("leanprover/lean4:nightly-2026-01-01"), null);
});

test("PF9: lake without elan: the project's pin is not enforced", (t) => {
	const m = machine(t, { rg: true });
	const sys = join(m.home, "usr", "bin");
	m.bin(sys, "lake");
	m.env.PATH = `${sys}:${join(m.home, "rgbin")}`;
	const r = m.run();
	assert.deepEqual(ids(r), ["lake-unmanaged"]);
	assert.match(r.findings[0].fix, /lake --version/);
});

test("PF10: dependencies — unresolved, not downloaded, Mathlib not built; offline makes them errors", (t) => {
	const m = machine(t, { lean: true, rg: true });
	m.file("lakefile.toml", 'name = "proj"\n[[require]]\nname = "mathlib"\nscope = "leanprover-community"\n');
	const unresolved = m.run();
	assert.deepEqual(ids(unresolved), ["deps-unresolved"]);
	assert.match(unresolved.findings[0].fix, /lake update.*lake exe cache get/s);
	m.file("lake-manifest.json", JSON.stringify({ packagesDir: ".lake/packages", packages: [{ name: "mathlib" }, { name: "batteries" }] }));
	const missing = m.run();
	assert.deepEqual(ids(missing), ["deps-missing"]);
	assert.match(missing.findings[0].problem, /mathlib, batteries/);
	assert.match(missing.findings[0].fix, /lake exe cache get.*lean_build \{fetchCache: true\}/s);
	assert.equal(m.run({ offline: true }).findings[0].severity, "error");
	mkdirSync(join(m.cwd, ".lake", "packages", "mathlib"), { recursive: true });
	mkdirSync(join(m.cwd, ".lake", "packages", "batteries"), { recursive: true });
	const unbuilt = m.run();
	assert.deepEqual(ids(unbuilt), ["mathlib-unbuilt"]);
	assert.match(unbuilt.findings[0].impact, /compile Mathlib from source/);
	m.file(".lake/packages/mathlib/.lake/build/lib/lean/Mathlib.olean", "x");
	assert.deepEqual(ids(m.run()), []);
});

test("PF11: non-Mathlib dependencies are fetched by lake build, not the Mathlib cache", (t) => {
	const m = machine(t, { lean: true, rg: true });
	m.file("lake-manifest.json", JSON.stringify({ packages: [{ name: "aesop" }] }));
	const r = m.run();
	assert.deepEqual(ids(r), ["deps-missing"]);
	assert.match(r.findings[0].fix, /lake build/);
	assert.doesNotMatch(r.findings[0].fix, /cache get/);
});

test("PF12: no ripgrep: a warning that names what is lost and the platform's install", (t) => {
	const m = machine(t, { lean: true });
	const linux = m.run();
	assert.deepEqual(ids(linux), ["rg-missing"]);
	assert.equal(linux.findings[0].severity, "warning");
	assert.match(linux.findings[0].impact, /lean_search \{source: "local"\}.*every other tool works/s);
	assert.match(linux.findings[0].fix, /apt-get install ripgrep/);
	assert.match(m.run({}, { platform: "darwin" }).findings[0].fix, /brew install ripgrep/);
	assert.deepEqual(ids(m.run({ rg: "/nope/rg" })), ["rg-config-wrong"]);
});

test("PF13: settings ignored in an untrusted project are mentioned, as info", (t) => {
	const m = machine(t, { lean: true, rg: true });
	m.file(".pi/settings.json", JSON.stringify({ lean4: { autoCheck: "always" } }));
	assert.deepEqual(ids(m.run({}, { trusted: true })), []);
	const r = m.run({}, { trusted: false });
	assert.deepEqual(ids(r), ["settings-untrusted"]);
	assert.equal(r.findings[0].severity, "info");
	assert.equal(fingerprintFindings(r), "", "info is not worth interrupting the model for");
});

test("PF14: started above Lake projects, the check covers the ones just below", (t) => {
	const m = machine(t, { project: false, lean: true, rg: true });
	for (const sub of ["a", "b"]) {
		m.file(`${sub}/lean-toolchain`, "leanprover/lean4:v4.30.0\n");
		m.file(`${sub}/lakefile.lean`, "import Lake\n");
	}
	assert.deepEqual(candidateRoots(m.cwd), [join(m.cwd, "a"), join(m.cwd, "b")]);
	assert.deepEqual(ids(m.run()), ["toolchain-missing", "toolchain-missing"]);
});

test("PF15: checkProject is what the runtime refuses on — offline with something to download", (t) => {
	const m = machine(t, { lean: true, rg: true });
	m.file("lake-manifest.json", JSON.stringify({ packages: [{ name: "mathlib" }] }));
	const errors = checkProject(m.cwd, { ...DEFAULTS, offline: true }, m.env).filter((f) => f.severity === "error");
	assert.deepEqual(
		errors.map((f) => f.id),
		["deps-missing"],
	);
	assert.match(asError(errors[0]), /offline|not downloaded/);
});

test("PF16: the model's version says what to do and not to retry; the human's lists fix lines", (t) => {
	const m = machine(t, { rg: false });
	const r = m.run();
	const agent = formatForAgent(r);
	assert.match(agent, /^\[pi-lean4 setup check\]/);
	assert.match(agent, /ERROR: lake \(Lean's build tool\) was not found/);
	assert.match(agent, /WARNING: ripgrep/);
	assert.match(agent, /only if the user agrees/);
	assert.match(agent, /Do not retry/);
	const user = formatForUser(r);
	assert.match(user, /^pi-lean4 setup: 2 issue\(s\)/);
	assert.match(user, /✖ lake .*\n {2}→ .*\n {2}Fix: Install Lean through elan/);
	assert.equal(fingerprintFindings(r), "lake-missing,rg-missing");
	assert.match(formatForAgent({ ...r, findings: [] }), /resolved/);
});
