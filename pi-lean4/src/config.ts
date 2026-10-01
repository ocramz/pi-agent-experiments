/**
 * The extension's configuration.
 *
 * Same shape as pi-notebook-py's `src/config.ts`: explicit overrides (tests,
 * and the `--lean-offline` flag), then the environment (containers, CI), then
 * the `lean4` key of the project's `.pi/settings.json`, then a default.
 *
 * The settings file is read only when the caller passes `cwd`, and the
 * extension passes it only for a trusted project — the rule pi applies to
 * `.pi/settings.json` itself. An untrusted repository must not be able to
 * point `lake` at a binary of its choosing.
 *
 * `.pi` is spelled out rather than imported from pi: this module runs in the
 * host unit tier, where pi is not installed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type AutoCheckMode = "off" | "running" | "always";

export interface ResolvedConfig {
	offline: boolean;
	autoCheck: AutoCheckMode;
	autoCheckTimeoutMs: number;
	guardrails: boolean;
	maxOpenFiles: number;
	scratchSlots: number;
	maxOutputChars: number;
	requestTimeoutMs: number;
	elaborationTimeoutMs: number;
	startTimeoutMs: number;
	buildTimeoutMs: number;
	/** Explicit binary paths. Set but missing means "not found", never a fallback. */
	lake?: string;
	rg?: string;
	autoprove: { maxCycles: number; maxStuckCycles: number; maxRuntimeMinutes: number };
	search: { leansearchUrl?: string; loogleUrl?: string; leanfinderUrl?: string; premiseUrl?: string };
}

export type Settings = Partial<Omit<ResolvedConfig, "autoprove" | "search">> & {
	autoprove?: Partial<ResolvedConfig["autoprove"]>;
	search?: Partial<ResolvedConfig["search"]>;
};

export const DEFAULTS: ResolvedConfig = {
	offline: false,
	autoCheck: "running",
	autoCheckTimeoutMs: 15_000,
	guardrails: true,
	maxOpenFiles: 4,
	scratchSlots: 1,
	maxOutputChars: 6000,
	requestTimeoutMs: 120_000,
	elaborationTimeoutMs: 600_000,
	startTimeoutMs: 120_000,
	buildTimeoutMs: 3_600_000,
	autoprove: { maxCycles: 20, maxStuckCycles: 3, maxRuntimeMinutes: 120 },
	search: {},
};

export interface ConfigOpts {
	/** Where to look for `.pi/settings.json`. Omit for an untrusted project. */
	cwd?: string;
	overrides?: Settings;
	env?: NodeJS.ProcessEnv;
}

function readSettings(cwd: string | undefined): Settings {
	if (!cwd) return {};
	try {
		const parsed = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")) as { lean4?: Settings };
		return parsed.lean4 && typeof parsed.lean4 === "object" ? parsed.lean4 : {};
	} catch {
		return {};
	}
}

function str(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const t = v.trim();
	return t ? t : undefined;
}

function bool(v: unknown): boolean | undefined {
	if (typeof v === "boolean") return v;
	const s = str(v)?.toLowerCase();
	if (s === undefined) return undefined;
	if (["1", "true", "yes", "on"].includes(s)) return true;
	if (["0", "false", "no", "off"].includes(s)) return false;
	return undefined;
}

function num(v: unknown): number | undefined {
	const n = typeof v === "number" ? v : Number(str(v));
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function mode(v: unknown): AutoCheckMode | undefined {
	const s = str(v)?.toLowerCase();
	return s === "off" || s === "running" || s === "always" ? s : undefined;
}

export function resolveConfig(opts: ConfigOpts = {}): ResolvedConfig {
	const o = opts.overrides ?? {};
	const e = opts.env ?? process.env;
	const s = readSettings(opts.cwd);
	const pick = <T>(parse: (v: unknown) => T | undefined, ...vals: unknown[]): T | undefined => {
		for (const v of vals) {
			const p = parse(v);
			if (p !== undefined) return p;
		}
		return undefined;
	};
	const d = DEFAULTS;
	return {
		offline: pick(bool, o.offline, e.PI_LEAN_OFFLINE, s.offline) ?? d.offline,
		autoCheck: pick(mode, o.autoCheck, e.PI_LEAN_AUTOCHECK, s.autoCheck) ?? d.autoCheck,
		autoCheckTimeoutMs:
			pick(num, o.autoCheckTimeoutMs, e.PI_LEAN_AUTOCHECK_TIMEOUT_MS, s.autoCheckTimeoutMs) ?? d.autoCheckTimeoutMs,
		guardrails: pick(bool, o.guardrails, e.PI_LEAN_GUARDRAILS, s.guardrails) ?? d.guardrails,
		maxOpenFiles: Math.floor(pick(num, o.maxOpenFiles, e.PI_LEAN_MAX_OPEN_FILES, s.maxOpenFiles) ?? d.maxOpenFiles),
		scratchSlots: Math.floor(pick(num, o.scratchSlots, e.PI_LEAN_SCRATCH_SLOTS, s.scratchSlots) ?? d.scratchSlots),
		maxOutputChars: pick(num, o.maxOutputChars, e.PI_LEAN_MAX_OUTPUT_CHARS, s.maxOutputChars) ?? d.maxOutputChars,
		requestTimeoutMs:
			pick(num, o.requestTimeoutMs, e.PI_LEAN_REQUEST_TIMEOUT_MS, s.requestTimeoutMs) ?? d.requestTimeoutMs,
		elaborationTimeoutMs:
			pick(num, o.elaborationTimeoutMs, e.PI_LEAN_ELABORATION_TIMEOUT_MS, s.elaborationTimeoutMs) ??
			d.elaborationTimeoutMs,
		startTimeoutMs: pick(num, o.startTimeoutMs, e.PI_LEAN_START_TIMEOUT_MS, s.startTimeoutMs) ?? d.startTimeoutMs,
		buildTimeoutMs: pick(num, o.buildTimeoutMs, e.PI_LEAN_BUILD_TIMEOUT_MS, s.buildTimeoutMs) ?? d.buildTimeoutMs,
		lake: pick(str, o.lake, e.PI_LEAN_LAKE, s.lake),
		rg: pick(str, o.rg, e.PI_LEAN_RG, s.rg),
		autoprove: {
			maxCycles: Math.floor(
				pick(num, o.autoprove?.maxCycles, e.PI_LEAN_AUTOPROVE_MAX_CYCLES, s.autoprove?.maxCycles) ??
					d.autoprove.maxCycles,
			),
			maxStuckCycles: Math.floor(
				pick(num, o.autoprove?.maxStuckCycles, e.PI_LEAN_AUTOPROVE_MAX_STUCK, s.autoprove?.maxStuckCycles) ??
					d.autoprove.maxStuckCycles,
			),
			maxRuntimeMinutes:
				pick(num, o.autoprove?.maxRuntimeMinutes, e.PI_LEAN_AUTOPROVE_MAX_RUNTIME_MINUTES, s.autoprove?.maxRuntimeMinutes) ??
				d.autoprove.maxRuntimeMinutes,
		},
		search: {
			leansearchUrl: pick(str, o.search?.leansearchUrl, e.PI_LEAN_LEANSEARCH_URL, s.search?.leansearchUrl),
			loogleUrl: pick(str, o.search?.loogleUrl, e.PI_LEAN_LOOGLE_URL, s.search?.loogleUrl),
			leanfinderUrl: pick(str, o.search?.leanfinderUrl, e.PI_LEAN_LEANFINDER_URL, s.search?.leanfinderUrl),
			premiseUrl: pick(str, o.search?.premiseUrl, e.PI_LEAN_PREMISE_URL, s.search?.premiseUrl),
		},
	};
}
