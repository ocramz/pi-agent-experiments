/**
 * lean_build: `lake build`, only when something changed.
 *
 * Lake is incremental, but even a no-op `lake build` walks every trace — and
 * the server has to be stopped around a build, because the build rewrites the
 * .oleans it has open. So the build is skipped outright when a fingerprint of
 * the project's sources (path, mtime, size of every .lean outside .lake, plus
 * the lakefile, manifest and toolchain) matches the last *successful* build's.
 * The stamp lives in <root>/.lake/pi-lean4/, next to what lake itself writes.
 *
 * Output handling follows lean-lsp-mcp build_utils.py (MIT, © 2025 Oliver
 * Dressler): `trace:` and `LEAN_PATH=` lines dropped, `[i/n]` lines reported
 * as progress, error lines collected.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { LeanToolError } from "../errors.ts";
import { findProjectRoot, resolveToolPath } from "../lean/project.ts";
import { killGroup, spawnGroup } from "../lean/process.ts";
import type { LeanRuntime } from "../lean/runtime.ts";
import { asError, lakeMissing } from "../lean/preflight.ts";
import { locate } from "../lean/toolchain.ts";
import type { OpContext, OpResult } from "./common.ts";

const SKIP = new Set([".lake", ".git", "build", "node_modules", ".pi"]);
const META = ["lakefile.lean", "lakefile.toml", "lake-manifest.json", "lean-toolchain"];

/**
 * Two hashes: the sources (every .lean outside .lake), and those plus the lake
 * files. The stamp is the second; the first is what tells a build that raced an
 * edit from one that did not — lake itself writes lake-manifest.json on a first
 * build, so the lake files are only stable *after* it.
 */
export function fingerprints(root: string): { sources: string; all: string } {
	const entries: string[] = [];
	const walk = (dir: string) => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const n of names) {
			if (SKIP.has(n)) continue;
			const p = join(dir, n);
			let st;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(p);
			else if (n.endsWith(".lean") && !n.startsWith("_PiLean4")) entries.push(`${relative(root, p)}:${st.mtimeMs}:${st.size}`);
		}
	};
	walk(root);
	entries.sort();
	const sources = createHash("sha256").update(entries.join("\n")).digest("hex");
	const meta: string[] = [];
	for (const m of META) {
		try {
			const st = statSync(join(root, m));
			meta.push(`${m}:${st.mtimeMs}:${st.size}`);
		} catch {
			/* absent is part of the fingerprint too */
		}
	}
	return { sources, all: createHash("sha256").update(`${sources}\n${meta.join("\n")}`).digest("hex") };
}

export function fingerprint(root: string): string {
	return fingerprints(root).all;
}

const stampFile = (root: string) => join(root, ".lake", "pi-lean4", "build-fingerprint.json");

export function loadStamp(root: string): string | null {
	try {
		return (JSON.parse(readFileSync(stampFile(root), "utf8")) as { fingerprint?: string }).fingerprint ?? null;
	} catch {
		return null;
	}
}

export function saveStamp(root: string, fp: string): void {
	try {
		mkdirSync(join(root, ".lake", "pi-lean4"), { recursive: true });
		writeFileSync(stampFile(root), JSON.stringify({ fingerprint: fp, at: new Date().toISOString() }));
	} catch {
		/* a missing stamp only costs a rebuild */
	}
}

export function keepLine(line: string): boolean {
	return !line.startsWith("trace:") && !line.includes("LEAN_PATH=");
}

export function progressOf(line: string): { done: number; total: number; what: string } | null {
	const m = /\[(\d+)\/(\d+)\]\s*(.+?)(?:\s+\(\d+\.?\d*[ms]+\))?$/.exec(line);
	return m ? { done: Number(m[1]), total: Number(m[2]), what: m[3] } : null;
}

/** Run a command in its own process group; abort or timeout kills the whole group. */
export async function runGroup(
	cmd: string,
	args: string[],
	opts: { cwd: string; signal?: AbortSignal; timeoutMs: number; onLine?: (line: string) => void; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; lines: string[]; timedOut: boolean; aborted: boolean }> {
	const h = spawnGroup(cmd, args, { cwd: opts.cwd, env: opts.env, stderrBytes: 64 * 1024 });
	const lines: string[] = [];
	let rest = "";
	const push = (chunk: string) => {
		const parts = (rest + chunk).split("\n");
		rest = parts.pop() ?? "";
		for (const l of parts) {
			lines.push(l);
			opts.onLine?.(l);
		}
	};
	h.child.stdout?.setEncoding("utf8");
	h.child.stdout?.on("data", push);
	h.child.stderr?.on("data", (c: string | Buffer) => push(String(c)));
	h.child.stdin?.end();
	let timedOut = false;
	let aborted = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void killGroup(h, { graceMs: 1000 });
	}, opts.timeoutMs);
	const onAbort = () => {
		aborted = true;
		void killGroup(h, { graceMs: 1000 });
	};
	if (opts.signal?.aborted) onAbort();
	else opts.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const { code } = await h.exited;
		if (rest) {
			lines.push(rest);
			opts.onLine?.(rest);
		}
		return { code, lines, timedOut, aborted };
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		await killGroup(h, { graceMs: 200 });
	}
}

export interface BuildInput {
	path?: string;
	clean?: boolean;
	fetchCache?: boolean;
	force?: boolean;
	outputLines?: number;
}

export async function buildOp(rt: LeanRuntime, input: BuildInput, oc: OpContext): Promise<OpResult> {
	const anchor = input.path ? resolveToolPath(input.path, oc.cwd) : oc.cwd;
	const root = findProjectRoot(anchor) ?? rt.boundRoot();
	if (!root) throw new LeanToolError("not inside a Lake project (no lean-toolchain + lakefile above the cwd); pass path");
	if (input.fetchCache && oc.cfg.offline) {
		throw new LeanToolError("fetchCache downloads Mathlib's build cache, which offline mode forbids");
	}
	const lake = locate("lake", { explicit: oc.cfg.lake });
	if (!lake.path) throw new LeanToolError(asError(lakeMissing(lake, oc.cfg)));
	const before = fingerprints(root);
	if (!input.clean && !input.fetchCache && !input.force && loadStamp(root) === before.all) {
		return {
			text: `${root}: up to date — nothing changed since the last successful lean_build, so lake was not invoked. Pass force: true to build anyway.`,
			details: { root, skipped: true, success: true },
		};
	}
	const keep = Math.max(0, input.outputLines ?? 20);
	return rt.exclusive(async () => {
		const signal = AbortSignal.any([rt.lifetime, ...(oc.signal ? [oc.signal] : [])]);
		const log: string[] = [];
		const errors: string[] = [];
		const onLine = (raw: string) => {
			const line = raw.replace(/\s+$/, "");
			if (!keepLine(line)) return;
			log.push(line);
			if (/\berror\b/i.test(line)) errors.push(line);
			const p = progressOf(line);
			if (p) oc.onProgress?.(`[${p.done}/${p.total}] ${p.what}`);
		};
		const steps: [string, string[]][] = [];
		if (input.clean) steps.push(["lake clean", ["clean"]]);
		if (input.fetchCache) steps.push(["lake exe cache get", ["exe", "cache", "get"]]);
		steps.push(["lake build", ["build"]]);
		for (const [label, args] of steps) {
			oc.onProgress?.(label);
			const r = await runGroup(lake.path!, args, { cwd: root, signal, timeoutMs: oc.cfg.buildTimeoutMs, onLine });
			if (r.aborted || signal.aborted) {
				const err = new Error(`${label} was aborted`);
				err.name = "AbortError";
				throw err;
			}
			if (r.timedOut || r.code !== 0) {
				const tail = log.slice(-keep).join("\n");
				const text = [
					`${label} failed${r.timedOut ? ` (timed out after ${Math.round(oc.cfg.buildTimeoutMs / 1000)}s)` : ` (exit ${r.code})`} in ${root}.`,
					...(errors.length ? ["errors:", ...errors.slice(0, 30)] : []),
					...(tail ? ["last output:", tail] : []),
				].join("\n");
				return { text, details: { root, skipped: false, success: false, step: label, errors, output: tail } };
			}
		}
		// Stamp what was built — unless a source changed while lake ran, in
		// which case the next lean_build must not be skipped.
		const after = fingerprints(root);
		if (after.sources === before.sources) saveStamp(root, after.all);
		const tail = log.slice(-keep).join("\n");
		return {
			text: `lake build succeeded in ${root}. The Lean server restarts on the next call, against the new build.${tail ? `\n${tail}` : ""}`,
			details: { root, skipped: false, success: true, output: tail, errors },
		};
	}, oc.signal);
}
