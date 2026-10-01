// Tiny dependency-free Lake projects for the Lean tier.
//
// Each fixture names the pinned toolchain (LEAN_TOOLCHAIN, from
// shared/versions.env through ../shared/with-versions.sh) in its
// lean-toolchain, so elan never downloads a second one mid-test. No Mathlib:
// core Lean builds such a project in about a second.
//
// The tier needs a Lean toolchain on the host and *fails* without one — a
// suite that skipped itself here would report green over the only coverage the
// LSP client gets against a real server. `make lean-install` provides it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { DEFAULTS, type ResolvedConfig } from "../../src/config.ts";
import { LeanRuntime } from "../../src/lean/runtime.ts";
import { locate } from "../../src/lean/toolchain.ts";
import type { OpContext } from "../../src/ops/common.ts";

export const TOOLCHAIN = process.env.LEAN_TOOLCHAIN ?? "";

export function requireLean(): { lake: string; rg: string | null } {
	assert.ok(
		TOOLCHAIN,
		"LEAN_TOOLCHAIN is unset: run this tier through `npm run test:lean`, which reads it from shared/versions.env.",
	);
	const lake = locate("lake");
	assert.ok(lake.path, "no lake found (PATH, $ELAN_HOME/bin, ~/.elan/bin). Install the pinned toolchain with `make lean-install`.");
	const v = execFileSync(lake.path, ["--version"], { cwd: tmpdir(), env: { ...process.env, ELAN_TOOLCHAIN: TOOLCHAIN }, encoding: "utf8" });
	assert.match(v, /Lake/, `lake --version said: ${v}`);
	return { lake: lake.path, rg: locate("rg").path };
}

export interface Project {
	root: string;
	path(rel: string): string;
	write(rel: string, text: string): void;
	build(): void;
}

export const BASIC = `def double (n : Nat) : Nat := n + n

theorem double_eq (n : Nat) : double n = 2 * n := by
  unfold double
  omega
`;

export const USE = `import Fixture.Basic

namespace Fixture

theorem use_double (n : Nat) : double n = n + n := by
  rfl

theorem with_sorry (a b : Nat) : a + b = b + a := by
  sorry

theorem extra_hyp (n : Nat) (h : 0 < n) (k : Nat) : n + k = k + n := by
  omega

end Fixture
`;

export function project(t: TestContext, files: Record<string, string> = { "Fixture/Basic.lean": BASIC, "Fixture/Use.lean": USE }, libs = ["Fixture"]): Project {
	const { lake } = requireLean();
	const root = mkdtempSync(join(tmpdir(), "pi-lean4-lean-"));
	t.after(() => {
		if (process.env.PI_LEAN_KEEP) console.log(`fixture kept: ${root}`);
		else rmSync(root, { recursive: true, force: true });
	});
	writeFileSync(join(root, "lean-toolchain"), `${TOOLCHAIN}\n`);
	writeFileSync(
		join(root, "lakefile.toml"),
		`name = "fixture"\ndefaultTargets = [${libs.map((l) => JSON.stringify(l)).join(", ")}]\n\n${libs.map((l) => `[[lean_lib]]\nname = "${l}"\nglobs = ["${l}.+"]\n`).join("\n")}`,
	);
	const p: Project = {
		root,
		path: (rel) => join(root, rel),
		write(rel, text) {
			mkdirSync(dirname(join(root, rel)), { recursive: true });
			writeFileSync(join(root, rel), text);
		},
		build() {
			try {
				execFileSync(lake, ["build"], { cwd: root, stdio: "pipe", encoding: "utf8" });
			} catch (err) {
				const e = err as { stdout?: string; stderr?: string };
				throw new Error(`fixture lake build failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
			}
		},
	};
	for (const [rel, text] of Object.entries(files)) p.write(rel, text);
	return p;
}

export function runtime(t: TestContext, cfg: Partial<ResolvedConfig> = {}): { rt: LeanRuntime; cfg: ResolvedConfig } {
	const full = { ...DEFAULTS, elaborationTimeoutMs: 120_000, ...cfg };
	const rt = new LeanRuntime({ config: () => full, clientVersion: "test" });
	t.after(() => rt.dispose());
	return { rt, cfg: full };
}

export function oc(p: Project, cfg: ResolvedConfig, extra: Partial<OpContext> = {}): OpContext {
	return { cwd: p.root, cfg, rg: locate("rg").path, ...extra };
}

/** Pids of `lean` processes whose command line mentions `needle`. */
export function leanProcesses(needle: string): number[] {
	try {
		const out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
		return out
			.split("\n")
			.filter((l) => /\b(lean|lake)\b/.test(l) && l.includes(needle))
			.map((l) => Number(l.trim().split(/\s+/)[0]))
			.filter((n) => n > 0 && n !== process.pid);
	} catch {
		return [];
	}
}
