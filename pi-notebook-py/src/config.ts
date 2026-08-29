/**
 * The extension's own configuration.
 *
 * The shape follows pi-incremental-py's `src/config.ts` and, through it,
 * pi-issue-tracker's — explicit overrides for tests, then the environment
 * for containers and CI, then the project's `.pi/settings.json` — so a
 * fourth setting has somewhere obvious to go.
 *
 * `.pi` is spelled out rather than imported as `CONFIG_DIR_NAME`. This
 * module is exercised by the host unit tier, which runs with no pi
 * installed at all, and a value import from the pi package would make it
 * unloadable there.
 *
 * What is *not* here: the per-notebook interpreter that `/nb-python`
 * writes. That is an absolute path to one machine's venv, and committing
 * it would break the notebook for everyone else — see `pinFile` in
 * `kernel.ts`. Settings carry the pin a team can share, spelled relative.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Everything the `notebookPy` key in `.pi/settings.json` may carry. */
export interface NotebookPySettings {
	/** Which notebook a session with no explicit selection starts on. */
	default?: string;
	/**
	 * Per-notebook interpreters, by notebook name. Relative paths resolve
	 * against the project, which is what makes `"./.venv"` shareable.
	 */
	python?: Record<string, string>;
	/** Where per-notebook venvs are built. Absolute, or relative to the project. */
	venvRoot?: string;
}

export type ConfigOverrides = NotebookPySettings;

export interface ConfigOpts {
	/** Where to look for `.pi/settings.json`. Omit to skip that read entirely — an
	 *  untrusted project's config is not honoured, the same rule pi applies to
	 *  `.pi/settings.json` itself. */
	cwd?: string;
	overrides?: ConfigOverrides;
	env?: NodeJS.ProcessEnv;
}

/** The notebook a session falls back to when nothing selects one. */
export const DEFAULT_NOTEBOOK = "default";

/** Project-local `.pi/settings.json`, under `notebookPy`. Absent or malformed is fine. */
function readSettings(cwd: string | undefined): NotebookPySettings {
	if (!cwd) return {};
	try {
		const raw = readFileSync(join(cwd, ".pi", "settings.json"), "utf8");
		const parsed = JSON.parse(raw) as { notebookPy?: NotebookPySettings };
		return parsed.notebookPy ?? {};
	} catch {
		return {};
	}
}

/** Unset and empty fall through to the next source rather than winning as "". */
function nonEmpty(value: string | undefined): string | undefined {
	const v = value?.trim();
	return v ? v : undefined;
}

/**
 * Which notebook to open with.
 *
 * Resolution order, first match wins:
 *   1. explicit overrides   (tests)
 *   2. PI_NOTEBOOK          (containers, CI)
 *   3. .pi/settings.json    (per project)
 *   4. "default"
 */
export function resolveDefaultNotebook(opts: ConfigOpts = {}): string {
	const { cwd, overrides = {}, env = process.env } = opts;
	return (
		nonEmpty(overrides.default) ??
		nonEmpty(env.PI_NOTEBOOK) ??
		nonEmpty(readSettings(cwd).default) ??
		DEFAULT_NOTEBOOK
	);
}

/**
 * Where per-notebook venvs are built.
 *
 * The default is deliberately outside the working tree. A venv is not
 * relocatable — `pyvenv.cfg` carries an absolute `home =` and console
 * scripts carry absolute shebangs — so a committed one is broken on every
 * other machine rather than merely large. Keying it off `$HOME` also means
 * a host and a container sharing a bind mount each build their own, which
 * they must: the interpreter, the libc and every compiled extension differ.
 *
 * Resolution order, first match wins:
 *   1. explicit overrides         (tests)
 *   2. PI_NOTEBOOK_VENV_ROOT      (containers, CI)
 *   3. .pi/settings.json          (per project)
 *   4. ~/.pi/notebook-py/venvs
 */
export function resolveVenvRoot(opts: ConfigOpts = {}): string {
	const { cwd, overrides = {}, env = process.env } = opts;
	const configured =
		nonEmpty(overrides.venvRoot) ??
		nonEmpty(env.PI_NOTEBOOK_VENV_ROOT) ??
		nonEmpty(readSettings(cwd).venvRoot);
	if (!configured) return join(userRoot(env), "venvs");
	return isAbsolute(configured) ? configured : resolve(cwd ?? process.cwd(), configured);
}

/**
 * A shareable per-notebook interpreter from `.pi/settings.json`, or undefined.
 *
 * Relative is the point: `"./.venv"` is the same instruction on every
 * machine, which an absolute path never is.
 */
export function settingsInterpreter(notebook: string, opts: ConfigOpts = {}): string | undefined {
	const { cwd, overrides = {} } = opts;
	const table = overrides.python ?? readSettings(cwd).python ?? {};
	const configured = nonEmpty(table[notebook]);
	if (!configured) return undefined;
	return isAbsolute(configured) ? configured : resolve(cwd ?? process.cwd(), configured);
}

/**
 * `~/.pi/notebook-py`, the machine-state root this extension owns: `venvs/`
 * and the machine-local `pins/`. `~/.pi` is already pi's user-level root, so
 * project files under `<cwd>/.pi` and machine state under `~/.pi` follow the
 * same convention at their own ends.
 *
 * `PI_NOTEBOOK_HOME` moves both at once, which is what the host unit tier
 * uses to stay inside its temp directory. `PI_NOTEBOOK_VENV_ROOT` moves only
 * the venvs, for a container volume or a faster disk.
 */
export function userRoot(env: NodeJS.ProcessEnv = process.env): string {
	return nonEmpty(env.PI_NOTEBOOK_HOME) ?? join(homedir(), ".pi", "notebook-py");
}
