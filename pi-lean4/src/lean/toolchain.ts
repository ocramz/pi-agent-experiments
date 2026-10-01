/**
 * Finding `lake`, `lean` and `rg`, and saying where each came from.
 *
 * Order: an explicit path from the config (missing means *not found* — a
 * typo'd PI_LEAN_LAKE must not quietly fall through to some other lake), then
 * PATH, then the places the installers put them: `$ELAN_HOME/bin` and
 * `~/.elan/bin` for elan's proxies, pi's own `bin/` (pi downloads rg there) and
 * `~/.local/bin` (scripts/toolchain.sh) for rg.
 */

import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface Located {
	path: string | null;
	source: string;
}

function executable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

export function elanHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.ELAN_HOME?.trim() || join(homedir(), ".elan");
}

export function locate(
	name: "lake" | "lean" | "rg",
	opts: { explicit?: string; env?: NodeJS.ProcessEnv; extraDirs?: string[] } = {},
): Located {
	const env = opts.env ?? process.env;
	if (opts.explicit) {
		return executable(opts.explicit)
			? { path: opts.explicit, source: "config" }
			: { path: null, source: `config (${opts.explicit} is not an executable file)` };
	}
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const p = join(dir, name);
		if (executable(p)) return { path: p, source: "PATH" };
	}
	const fallbacks =
		name === "rg"
			? [...(opts.extraDirs ?? []), join(homedir(), ".local", "bin")]
			: [join(elanHome(env), "bin"), join(homedir(), ".elan", "bin")];
	for (const dir of fallbacks) {
		const p = join(dir, name);
		if (executable(p)) return { path: p, source: dir };
	}
	return { path: null, source: "not found" };
}

export const INSTALL_HINT =
	"Install Lean with elan (https://lean-lang.org/install/ — `curl https://elan.lean-lang.org/elan-init.sh -sSf | sh`), " +
	"or point PI_LEAN_LAKE / the lean4.lake setting at a lake binary.";

/** elan's directory name for a toolchain line: `leanprover/lean4:v4.34.1` → `leanprover--lean4---v4.34.1`. */
export function toolchainDirName(toolchain: string): string {
	return toolchain.trim().replace(/\//g, "--").replace(/:/g, "---");
}

/**
 * Whether elan already has the toolchain a project pins. When it does not,
 * starting `lake serve` makes elan download it — fine online, a network call
 * that offline mode exists to prevent.
 */
export function toolchainInstalled(toolchain: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
	if (!toolchain) return true; // nothing pinned: elan uses its default, already present or not our call
	if (!/[/:]/.test(toolchain)) return true; // a channel name such as `stable`: not resolvable offline anyway
	return existsSync(join(elanHome(env), "toolchains", toolchainDirName(toolchain)));
}

/** Run a short command and capture stdout; never throws. */
export function capture(
	cmd: string,
	args: string[],
	opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{
				cwd: opts.cwd,
				timeout: opts.timeoutMs ?? 30_000,
				signal: opts.signal,
				env: opts.env ?? process.env,
				maxBuffer: 16 * 1024 * 1024,
				killSignal: "SIGKILL",
			},
			(err, stdout, stderr) => {
				const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null) : 0;
				resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err ? err.message : "")) });
			},
		);
	});
}

/** The Lean sysroot a project's toolchain uses (`lean --print-prefix`), or null. */
export async function leanPrefix(lean: string, root: string): Promise<string | null> {
	const r = await capture(lean, ["--print-prefix"], { cwd: root, timeoutMs: 60_000 });
	const p = r.stdout.trim().split("\n").pop()?.trim();
	return r.code === 0 && p && existsSync(p) ? p : null;
}
