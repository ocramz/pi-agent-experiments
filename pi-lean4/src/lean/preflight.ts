/**
 * What is missing or wrong in this machine's Lean setup, and how to fix it.
 *
 * Run at session start, on demand by `/lean status`, and — through the message
 * builders — wherever a tool fails for one of these reasons, so the human, the
 * model and the error result all name the same cause and the same fix.
 *
 * Cheap on purpose: file lookups only. No process is spawned and nothing touches
 * the network, so it can run at session start (pi forbids starting processes
 * there) and on every turn without cost. That also bounds what it can know: it
 * finds `lake`, but cannot ask it its version; it sees that Mathlib's build
 * files are missing, but not whether they are current.
 *
 * Every finding carries what is wrong, what it breaks, and the fix — commands
 * to run, not advice to "check your installation".
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, relative, sep } from "node:path";
import type { ResolvedConfig } from "../config.ts";
import { findProjectRoot, isProjectRoot, projectInfo } from "./project.ts";
import { type Located, elanHome, homeOf, locate, toolchainInstalled } from "./toolchain.ts";

export type Severity = "error" | "warning" | "info";

export interface Finding {
	id:
		| "lake-missing"
		| "lake-config-wrong"
		| "lake-not-on-path"
		| "lake-unmanaged"
		| "toolchain-missing"
		| "toolchain-offline"
		| "toolchain-old"
		| "deps-unresolved"
		| "deps-missing"
		| "mathlib-unbuilt"
		| "rg-missing"
		| "rg-config-wrong"
		| "not-a-project"
		| "settings-untrusted";
	severity: Severity;
	/** What is wrong, in one sentence. */
	problem: string;
	/** What it breaks. */
	impact: string;
	/** What to do: concrete commands. */
	fix: string;
}

export interface PreflightReport {
	/** The Lake projects the checks were about (the cwd's, or ones just below it). */
	roots: string[];
	lake: Located;
	rg: Located;
	findings: Finding[];
}

export interface PreflightOptions {
	cwd: string;
	cfg: ResolvedConfig;
	/** Whether the project's .pi/settings.json is honoured (pi's trust). */
	trusted: boolean;
	env?: NodeJS.ProcessEnv;
	/** Extra places to look for rg (pi's own bin/). */
	rgDirs?: string[];
	platform?: NodeJS.Platform;
}

/** The oldest Lean the server protocol this extension relies on is known to work with. */
export const MIN_LEAN = [4, 24, 0] as const;
/** The toolchain the extension is tested against (shared/versions.env). */
export const TESTED_LEAN = "v4.34.1";

const ELAN_INSTALL = "curl https://elan.lean-lang.org/elan-init.sh -sSf | sh -s -- -y";

// ── message builders, shared with the tools' own errors ─────────────

export function lakeMissing(lake: Located, cfg: Pick<ResolvedConfig, "lake">, env: NodeJS.ProcessEnv = process.env): Finding {
	if (cfg.lake) {
		return {
			id: "lake-config-wrong",
			severity: "error",
			problem: `lake is configured as ${cfg.lake} (PI_LEAN_LAKE or the lean4.lake setting), which is not an executable file.`,
			impact: "Every Lean tool fails.",
			fix: `Point PI_LEAN_LAKE / lean4.lake at a real lake binary (usually ${join(elanHome(env), "bin", "lake")}), or unset it to search PATH and ~/.elan/bin.`,
		};
	}
	return {
		id: "lake-missing",
		severity: "error",
		problem: `lake (Lean's build tool) was not found on PATH, in ${join(elanHome(env), "bin")} or in ~/.elan/bin.`,
		impact: "Every Lean tool fails until Lean is installed; nothing else is affected.",
		fix:
			`Install Lean through elan: \`${ELAN_INSTALL}\` (see https://lean-lang.org/install/). ` +
			"The Lean tools find ~/.elan/bin/lake on their next call, without restarting pi; for `lake` commands in bash, " +
			"also add ~/.elan/bin to PATH (the installer edits your shell profile; restart pi to pick that up).",
	};
}

export function toolchainMissing(toolchain: string, root: string, offline: boolean, elan: string | null): Finding {
	const install = `${elan ?? "elan"} toolchain install ${toolchain}`;
	if (offline) {
		return {
			id: "toolchain-offline",
			severity: "error",
			problem: `${root} pins ${toolchain} (lean-toolchain), which elan has not installed, and offline mode forbids downloading it.`,
			impact: "The Lean server cannot start for this project.",
			fix: `Install it once with network access: \`${install}\` — or turn offline mode off (unset PI_LEAN_OFFLINE / drop --lean-offline).`,
		};
	}
	return {
		id: "toolchain-missing",
		severity: "warning",
		problem: `${root} pins ${toolchain} (lean-toolchain), which elan has not installed yet.`,
		impact: "The first Lean tool call downloads it (a few hundred MB), so it will be slow once.",
		fix: `Install it ahead of time: \`${install}\`.`,
	};
}

export function rgMissing(cfg: Pick<ResolvedConfig, "rg">, platform: NodeJS.Platform = process.platform): Finding {
	if (cfg.rg) {
		return {
			id: "rg-config-wrong",
			severity: "warning",
			problem: `ripgrep is configured as ${cfg.rg} (PI_LEAN_RG or the lean4.rg setting), which is not an executable file.`,
			impact: 'lean_search {source: "local"} is unavailable; every other tool works.',
			fix: "Point PI_LEAN_RG / lean4.rg at the rg binary, or unset it to search PATH, pi's bin directory and ~/.local/bin.",
		};
	}
	const install =
		platform === "darwin"
			? "`brew install ripgrep`"
			: platform === "linux"
				? "`sudo apt-get install ripgrep` (Debian/Ubuntu), `sudo dnf install ripgrep` (Fedora), or a release binary into ~/.local/bin"
				: "a package from https://github.com/BurntSushi/ripgrep#installation";
	return {
		id: "rg-missing",
		severity: "warning",
		problem: "ripgrep (rg) was not found on PATH, in pi's bin directory or in ~/.local/bin.",
		impact: 'lean_search {source: "local"} — the offline name search over the project, its packages and Lean core — is unavailable; every other tool works.',
		fix: `Install ripgrep: ${install}. No restart needed.`,
	};
}

/** A tool error from a finding: the problem, then the fix. */
export function asError(f: Finding): string {
	return `${f.problem} ${f.fix}`;
}

// ── the checks ───────────────────────────────────────────────────────

function onPath(dir: string, env: NodeJS.ProcessEnv): boolean {
	return (env.PATH ?? "").split(delimiter).some((d) => d && (d === dir || d.replace(/\/+$/, "") === dir));
}

function realpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

export function parseLeanVersion(toolchain: string): [number, number, number] | null {
	const m = /:v?(\d+)\.(\d+)\.(\d+)/.exec(toolchain);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function older(a: readonly number[], b: readonly number[]): boolean {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] < b[i];
	}
	return false;
}

/** The Lake projects to check: the cwd's own, else ones directly below it. */
export function candidateRoots(cwd: string, limit = 5): string[] {
	const own = findProjectRoot(cwd);
	if (own) return [own];
	const out: string[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(cwd);
	} catch {
		return out;
	}
	for (const n of names.sort()) {
		if (n.startsWith(".") || n === "node_modules") continue;
		const d = join(cwd, n);
		try {
			if (statSync(d).isDirectory() && isProjectRoot(d)) out.push(d);
		} catch {
			/* unreadable entry */
		}
		if (out.length >= limit) break;
	}
	return out;
}

interface Manifest {
	packagesDir?: string;
	packages?: { name?: string }[];
}

function requiresPackages(root: string): boolean {
	for (const [file, re] of [
		["lakefile.lean", /^\s*require\s/m],
		["lakefile.toml", /^\s*\[\[require\]\]/m],
	] as const) {
		try {
			if (re.test(readFileSync(join(root, file), "utf8"))) return true;
		} catch {
			/* no such lakefile */
		}
	}
	return false;
}

/**
 * The checks about one project. The runtime calls this before starting a
 * server and refuses on any error-level finding (e.g. offline mode with a
 * toolchain or dependencies still to download).
 */
export function checkProject(
	root: string,
	cfg: ResolvedConfig,
	env: NodeJS.ProcessEnv = process.env,
	lake: Located = locate("lake", { explicit: cfg.lake, env }),
	elan: string | null = locateElan(env),
): Finding[] {
	const out: Finding[] = [];
	const info = projectInfo(root);
	const tc = info.toolchain;
	if (tc && lake.path) {
		const managed = elan !== null;
		if (managed && !toolchainInstalled(tc, env)) out.push(toolchainMissing(tc, root, cfg.offline, elan));
		if (!managed && /[/:]/.test(tc)) {
			out.push({
				id: "lake-unmanaged",
				severity: "warning",
				problem: `${root} pins ${tc}, but the lake at ${lake.path} is not managed by elan, so that pin is not enforced.`,
				impact: "A different Lean version than the project expects gives confusing errors (e.g. incompatible .olean headers).",
				fix: `Install elan (\`${ELAN_INSTALL}\`) so each project gets its pinned toolchain, or make sure \`lake --version\` matches ${tc}.`,
			});
		}
		const v = parseLeanVersion(tc);
		if (v && older(v, MIN_LEAN)) {
			out.push({
				id: "toolchain-old",
				severity: "warning",
				problem: `${root} uses Lean ${v.join(".")}; pi-lean4 needs Lean ${MIN_LEAN.join(".")} or newer (tested with ${TESTED_LEAN}).`,
				impact: "The language server may lack features the tools rely on; some calls may hang or fail.",
				fix: `Move the project to a newer toolchain: update lean-toolchain (and its dependencies, e.g. \`lake update\`) — for Mathlib projects, follow Mathlib's own upgrade instructions.`,
			});
		}
	}

	const manifestPath = join(root, "lake-manifest.json");
	let manifest: Manifest | null = null;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
	} catch {
		manifest = null;
	}
	if (!manifest && requiresPackages(root)) {
		out.push({
			id: "deps-unresolved",
			severity: cfg.offline ? "error" : "warning",
			problem: `${root}'s lakefile requires packages, but there is no lake-manifest.json: the dependencies were never resolved.`,
			impact: cfg.offline
				? "Starting the Lean server would make Lake fetch them, which offline mode cannot allow; the tools will fail."
				: "The first Lean call makes Lake clone them, which can take long; for Mathlib it would then compile Mathlib from source (hours).",
			fix: `In ${root}, run \`lake update\` once to resolve and fetch them; for a Mathlib project follow it with \`lake exe cache get\` to download Mathlib's prebuilt files.`,
		});
	}
	if (manifest?.packages?.length) {
		const dir = join(root, manifest.packagesDir ?? join(".lake", "packages"));
		const missing = manifest.packages.map((p) => p.name ?? "").filter((n) => n && !existsSync(join(dir, n)));
		const hasMathlib = manifest.packages.some((p) => p.name === "mathlib");
		if (missing.length) {
			out.push({
				id: "deps-missing",
				severity: cfg.offline ? "error" : "warning",
				problem: `${root} depends on packages that are not downloaded yet: ${missing.join(", ")}.`,
				impact: cfg.offline
					? "Starting the Lean server would make Lake fetch them, which offline mode cannot allow; the tools will fail."
					: "The first Lean call makes Lake clone them (slow), and imports from them fail until they are built.",
				fix: hasMathlib
					? `In ${root}, run \`lake exe cache get\` — it fetches the packages and downloads Mathlib's prebuilt files (or ask the agent for lean_build {fetchCache: true}).`
					: `In ${root}, run \`lake build\` (it fetches and builds them), or ask the agent for lean_build {}.`,
			});
		} else if (hasMathlib) {
			const built = join(dir, "mathlib", ".lake", "build", "lib", "lean", "Mathlib.olean");
			if (!existsSync(built)) {
				out.push({
					id: "mathlib-unbuilt",
					severity: "warning",
					problem: `Mathlib's build files are missing in ${relative(root, join(dir, "mathlib")) || dir}.`,
					impact: "Opening any file that imports Mathlib would compile Mathlib from source — hours of CPU, and the tools time out meanwhile.",
					fix: `In ${root}, run \`lake exe cache get\` to download Mathlib's prebuilt files (minutes), or ask the agent for lean_build {fetchCache: true}.`,
				});
			}
		}
	}
	return out;
}

/** Locate the elan binary itself (not a proxy). */
export function locateElan(env: NodeJS.ProcessEnv): string | null {
	for (const dir of [...(env.PATH ?? "").split(delimiter).filter(Boolean), join(elanHome(env), "bin"), join(homeOf(env), ".elan", "bin")]) {
		const p = join(dir, "elan");
		if (existsSync(p)) return p;
	}
	return null;
}

export function preflight(opts: PreflightOptions): PreflightReport {
	const env = opts.env ?? process.env;
	const cfg = opts.cfg;
	const lake = locate("lake", { explicit: cfg.lake, env });
	const rg = locate("rg", { explicit: cfg.rg, env, extraDirs: opts.rgDirs });
	const roots = candidateRoots(opts.cwd);
	const findings: Finding[] = [];

	if (roots.length === 0) {
		// Not a Lean session — unless the directory looks like one that is
		// missing its Lake project, which is worth saying once.
		let leanFiles: string[] = [];
		try {
			leanFiles = readdirSync(opts.cwd).filter((f) => f.endsWith(".lean"));
		} catch {
			leanFiles = [];
		}
		const partial = ["lean-toolchain", "lakefile.lean", "lakefile.toml"].filter((f) => existsSync(join(opts.cwd, f)));
		if (leanFiles.length || partial.length) {
			const has = partial.length ? `it has ${partial.join(" and ")} but` : `it has ${leanFiles.length} .lean file(s) but`;
			findings.push({
				id: "not-a-project",
				severity: "warning",
				problem: `${opts.cwd} is not a Lake project: ${has} a project root needs both lean-toolchain and lakefile.lean (or lakefile.toml).`,
				impact: "The Lean tools refuse files outside a Lake project.",
				fix:
					`Make it one: \`lake init <name>\` in ${opts.cwd} (or \`lake new <name>\` for a fresh directory; \`lake new <name> math\` for a Mathlib project), ` +
					"or start pi from the project's root.",
			});
		}
		return { roots, lake, rg, findings };
	}

	const elan = locateElan(env);
	if (!lake.path) {
		findings.push(lakeMissing(lake, cfg, env));
	} else {
		const dir = lake.path.slice(0, lake.path.lastIndexOf(sep));
		if (lake.source !== "PATH" && lake.source !== "config" && !onPath(dir, env)) {
			findings.push({
				id: "lake-not-on-path",
				severity: "warning",
				problem: `lake was found at ${lake.path}, but ${dir} is not on PATH.`,
				impact:
					"The Lean tools work (they use the full path), but `lake`/`lean` commands run in bash — the file gate `lake env lean <file>`, `lake build` — fail with \"command not found\".",
				fix: `Add it to PATH: \`echo 'export PATH="${dir}:$PATH"' >> ~/.profile\` and restart pi; until then, prefix bash commands with \`PATH="${dir}:$PATH"\`.`,
			});
		}
	}
	for (const root of roots) findings.push(...checkProject(root, cfg, env, lake, elan ? realpath(elan) : null));
	if (!rg.path) findings.push(rgMissing(cfg, opts.platform));

	if (!opts.trusted) {
		const ignored = roots.filter((r) => {
			try {
				return "lean4" in (JSON.parse(readFileSync(join(r, ".pi", "settings.json"), "utf8")) as object);
			} catch {
				return false;
			}
		});
		if (ignored.length) {
			findings.push({
				id: "settings-untrusted",
				severity: "info",
				problem: `${join(ignored[0], ".pi", "settings.json")} has lean4 settings, but the project is not trusted, so they are ignored.`,
				impact: "pi-lean4 runs with its defaults and environment variables instead.",
				fix: "Trust the project (start pi with --approve, or accept the trust prompt), or set the same values through PI_LEAN_* environment variables.",
			});
		}
	}
	return { roots, lake, rg, findings };
}

// ── rendering ─────────────────────────────────────────────────────────

const ICON: Record<Severity, string> = { error: "✖", warning: "⚠", info: "ℹ" };

export function worst(findings: readonly Finding[]): Severity | null {
	if (findings.some((f) => f.severity === "error")) return "error";
	if (findings.some((f) => f.severity === "warning")) return "warning";
	return findings.length ? "info" : null;
}

/** For the human: one block per finding. */
export function formatForUser(report: PreflightReport): string {
	if (!report.findings.length) return "pi-lean4 setup: ok";
	const lines = [`pi-lean4 setup: ${report.findings.length} issue(s)`];
	for (const f of report.findings) lines.push(`${ICON[f.severity]} ${f.problem}`, `  → ${f.impact}`, `  Fix: ${f.fix}`);
	return lines.join("\n");
}

/**
 * For the model: what it can and cannot rely on, and what to do — fix it with
 * the user's go-ahead, or tell them how. Never "retry until it works".
 */
export function formatForAgent(report: PreflightReport): string {
	const relevant = report.findings.filter((f) => f.severity !== "info");
	if (!relevant.length) return "[pi-lean4 setup check] The issues reported earlier are resolved; the Lean tools can be used normally.";
	const lines = [
		"[pi-lean4 setup check] Problems with this machine's Lean setup (checked at session start; file lookups only):",
		...relevant.map((f) => `- ${f.severity.toUpperCase()}: ${f.problem} ${f.impact} Fix: ${f.fix}`),
		"Before relying on an affected tool, tell the user what is wrong and the fix. You may run a fix yourself (e.g. an install command) only if the user agrees. " +
			"Do not retry a tool that fails for one of these reasons; its error repeats the fix. `/lean status` re-runs this check.",
	];
	return lines.join("\n");
}

/** Short footer text, or undefined when there is nothing to say. */
export function statusBadge(report: PreflightReport): string | undefined {
	const errors = report.findings.filter((f) => f.severity === "error");
	if (errors.length) return `lean ✖ ${errors[0].id === "lake-missing" || errors[0].id === "lake-config-wrong" ? "lake not found" : "setup error"} (/lean status)`;
	const warnings = report.findings.filter((f) => f.severity === "warning").length;
	return warnings ? `lean ⚠ ${warnings} setup warning(s) (/lean status)` : undefined;
}

/** Stable key of the findings, to notice when they change. */
export function fingerprintFindings(report: PreflightReport): string {
	return report.findings
		.filter((f) => f.severity !== "info")
		.map((f) => f.id)
		.sort()
		.join(",");
}

