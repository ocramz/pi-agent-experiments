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
