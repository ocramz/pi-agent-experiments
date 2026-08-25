/**
 * The extension's own configuration.
 *
 * One flag today, but the shape follows pi-issue-tracker's `src/config.ts` —
 * explicit overrides for tests, then the environment for containers and CI,
 * then the project's `.pi/settings.json` — so a second setting has somewhere
 * obvious to go.
 *
 * `.pi` is spelled out rather than imported as `CONFIG_DIR_NAME`. This module
 * is exercised by the host unit tier, which runs with no pi installed at all,
 * and a value import from the pi package would make it unloadable there.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Everything the `incrementalPy` key in `.pi/settings.json` may carry. */
export interface IncrementalPySettings {
	/** Hide superseded kernel output from the model. Default true. */
	contextFilter?: boolean;
	/**
	 * Bytes of computed value to keep so that switching back to a variant
	 * restores rather than recomputes. Default 256 MB; 0 disables the memo.
	 */
	memoBudgetBytes?: number;
}

export type ConfigOverrides = IncrementalPySettings;

/** Project-local `.pi/settings.json`, under `incrementalPy`. Absent or malformed is fine. */
function readSettings(cwd: string | undefined): IncrementalPySettings {
	if (!cwd) return {};
	try {
		const raw = readFileSync(join(cwd, ".pi", "settings.json"), "utf8");
		const parsed = JSON.parse(raw) as { incrementalPy?: IncrementalPySettings };
		return parsed.incrementalPy ?? {};
	} catch {
		return {};
	}
}

/**
 * `0`, `false`, `no` and `off` are false; any other non-empty value is true.
 *
 * Unset and empty are `undefined` rather than false, so an exported-but-blank
 * variable falls through to the next source instead of silently winning.
 */
function readBool(value: string | undefined): boolean | undefined {
	const v = value?.trim().toLowerCase();
	if (!v) return undefined;
	return !(v === "0" || v === "false" || v === "no" || v === "off");
}

/** A non-negative integer, or undefined so the next source gets a turn. */
function readBytes(value: string | undefined): number | undefined {
	const v = value?.trim();
	if (!v) return undefined;
	const n = Number(v);
	return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * How many bytes of computed value the kernel may keep.
 *
 * This is what makes switching back to a variant a restore rather than a
 * re-run, so the cost of setting it to 0 is paid in recomputation, not in
 * correctness. Same resolution order as above; `undefined` means "leave the
 * kernel's own default alone".
 */
export function resolveMemoBudget(opts: {
	cwd?: string;
	overrides?: ConfigOverrides;
	env?: NodeJS.ProcessEnv;
}): number | undefined {
	const { cwd, overrides = {}, env = process.env } = opts;
	return (
		overrides.memoBudgetBytes ??
		readBytes(env.PI_PY_MEMO_BUDGET) ??
		readSettings(cwd).memoBudgetBytes
	);
}

/**
 * Whether to hide superseded kernel output from the model.
 *
 * On by default: showing the agent values the kernel has already recomputed
 * is the defect this exists to fix, so the flag is the escape hatch and not
 * the opt-in.
 *
 * Resolution order, first match wins:
 *   1. explicit overrides      (tests)
 *   2. PI_PY_CONTEXT_FILTER    (containers, CI)
 *   3. .pi/settings.json       (per project)
 *   4. true
 */
export function resolveContextFilter(opts: {
	/** Where to look for `.pi/settings.json`. Omit to skip that read entirely — an
	 *  untrusted project's config is not honoured, the same rule pi applies to
	 *  `.pi/settings.json` itself. */
	cwd?: string;
	overrides?: ConfigOverrides;
	env?: NodeJS.ProcessEnv;
}): boolean {
	const { cwd, overrides = {}, env = process.env } = opts;
	return (
		overrides.contextFilter ??
		readBool(env.PI_PY_CONTEXT_FILTER) ??
		readSettings(cwd).contextFilter ??
		true
	);
}
