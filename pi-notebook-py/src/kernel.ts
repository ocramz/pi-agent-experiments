/**
 * Long-lived Python kernel subprocess speaking the JSON-lines protocol.
 *
 * One Kernel per pi session, lazily spawned on first use. Calls are
 * serialised through a promise chain: the protocol is one-request /
 * one-response on a single pipe, so concurrent tool calls must queue.
 * If the process dies, the next call respawns it and flags the loss.
 *
 * This is pi-incremental-py's `src/kernel.ts`, vendored rather than shared:
 * `files` in package.json ships only package-local paths, so a runtime
 * import out of ../shared would install cleanly and fail at load. 
 * Note: 
 * - the spawn forces a headless matplotlib backend
 * - there is no PYTHONHASHSEED pin because this kernel has no content-addressed 
 * cache whose keys would have to survive a restart
 * - the interpreter is chosen per *notebook* rather than per project
 * - the bootstrap is async, so building a venv does not freeze pi's event loop
 * - and the state directory is `<cwd>/.pi` for the things a project commits,
 *   with the venvs deliberately outside the working tree (see `config.ts`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
	type ConfigOpts,
	resolveDefaultNotebook,
	resolveVenvRoot,
	settingsInterpreter,
	userRoot,
} from "./config.ts";

export interface KernelResponse {
	ok: boolean;
	error?: string;
	internal?: boolean;
	[key: string]: unknown;
}

const PY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "py");

/** The project-local directory, per pi's convention. Tracked, not machine state. */
export const STATE_DIR = ".pi";

/** Where the committed notebooks live, under `STATE_DIR`. */
export const NOTEBOOKS_DIR = "notebooks";

/**
 * What a notebook may be called.
 *
 * The name is a path segment (a venv directory) and a filename (the
 * checkpoint), so anything with a separator or a leading dot is refused
 * rather than escaped : it is not possible to call a notebook `../../etc`.
 */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** An explanation of why this name is unusable, or null if it is fine. */
export function nameError(name: string): string | null {
	if (!name) return "a notebook name is required";
	if (name.length > 64) return `notebook name is too long (${name.length} > 64)`;
	if (!NAME_PATTERN.test(name)) {
		return (
			`invalid notebook name ${JSON.stringify(name)} — letters, digits, dot, dash ` +
			"and underscore only, starting with a letter or digit"
		);
	}
	return null;
}

/**
 * The key a project's venvs are filed under.
 *
 * The basename makes the directory recognisable when someone goes looking
 * for what is eating their disk; the hash is what actually distinguishes
 * two checkouts with the same name. Resolved through `realpath` so a
 * symlinked checkout and its target agree on one slug.
 */
export function projectSlug(cwd: string): string {
	let real = cwd;
	try {
		real = realpathSync(cwd);
	} catch {
		/* not created yet — the literal path is still a stable key */
	}
	const hash = createHash("sha256").update(real).digest("hex").slice(0, 8);
	const base = basename(real).replace(/[^A-Za-z0-9._-]/g, "_") || "project";
	return `${base}-${hash}`;
}

/** `<cwd>/.pi/notebooks/<name>.py` — the checkpoint, and the thing to commit. */
export function notebookFile(cwd: string, notebook: string): string {
	return join(cwd, STATE_DIR, NOTEBOOKS_DIR, `${notebook}.py`);
}

/** `<venvRoot>/<slug>/<name>` — outside the working tree unless told otherwise. */
export function venvDir(cwd: string, notebook: string, opts: ConfigOpts = {}): string {
	return join(resolveVenvRoot({ ...opts, cwd }), projectSlug(cwd), notebook);
}

/**
 * The machine-local pin `/nb-python` writes.
 *
 * Not in `.pi/settings.json`: what `/nb-python` is handed is an absolute
 * path to one machine's interpreter, and committing that would hand
 * everyone else a path that does not exist. A pin a team *can* share is
 * spelled relative and lives in settings — see `settingsInterpreter`.
 */
export function pinFile(cwd: string, notebook: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(userRoot(env), "pins", projectSlug(cwd), notebook);
}

export function pinPython(
	cwd: string,
	notebook: string,
	interpreter: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const file = pinFile(cwd, notebook, env);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, interpreter + "\n");
}

/** Forget a pin, so the notebook goes back to its own venv. */
export function unpinPython(
	cwd: string,
	notebook: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	rmSync(pinFile(cwd, notebook, env), { force: true });
}

/** A venv directory resolves to its interpreter; anything else is one already. */
function asInterpreter(path: string): string {
	const inside = join(path, "bin", "python");
	return existsSync(inside) ? inside : path;
}

function readPin(file: string): string | null {
	if (!existsSync(file)) return null;
	const pin = readFileSync(file, "utf8").trim();
	return pin || null;
}

export interface Planned {
	/** Which rule chose it, for the message the human reads. */
	source: "env" | "pin" | "settings" | "venv";
	python: string;
	/** Set only for `venv`: the directory that would be built. */
	venv?: string;
}

/**
 * Which interpreter this notebook *would* run under, with no side effects.
 *
 * Split out from `resolvePython` so listing notebooks, and reporting what
 * one is pinned to, do not build a venv as a side effect of being asked.
 *
 * Resolution order:
 *  1. `PI_PYTHON` (escape hatch, e.g. tests).
 *  2. The machine-local pin written by `/nb-python`.
 *  3. `notebookPy.python[<name>]` in `.pi/settings.json` — the shareable pin.
 *  4. A venv this extension builds and owns, outside the working tree.
 */
export function plannedInterpreter(
	cwd: string,
	notebook: string,
	opts: ConfigOpts = {},
): Planned {
	const env = opts.env ?? process.env;
	if (env.PI_PYTHON) return { source: "env", python: env.PI_PYTHON };

	const pin = readPin(pinFile(cwd, notebook, env));
	if (pin) return { source: "pin", python: asInterpreter(pin) };

	const shared = settingsInterpreter(notebook, { ...opts, cwd });
	if (shared) return { source: "settings", python: asInterpreter(shared) };

	const venv = venvDir(cwd, notebook, opts);
	return { source: "venv", python: join(venv, "bin", "python"), venv };
}

/**
 * Which interpreter the kernel runs under, and therefore which environment
 * `nb_install` installs into — building the notebook's venv if that is what
 * it comes to.
 */
export async function resolvePython(
	cwd: string,
	notebook: string,
	opts: ConfigOpts = {},
): Promise<string> {
	const planned = plannedInterpreter(cwd, notebook, opts);
	if (planned.source !== "venv") return planned.python;

	const venv = planned.venv!;
	// A venv already built from a too-old base is worse than no venv: it exists,
	// so it would be reused forever, and every kernel call dies on a SyntaxError
	// from an install that looks perfectly healthy. Rebuild it instead.
	const stale = existsSync(planned.python) && !meetsFloor(await interpreterVersion(planned.python));
	if (existsSync(planned.python) && !stale) return planned.python;

	const base = await basePython(opts.env ?? process.env);
	if (!base) return "python3"; // nothing to build from; let spawn fail loudly
	mkdirSync(dirname(venv), { recursive: true });
	await ensureVenvIgnored(cwd, resolveVenvRoot({ ...opts, cwd }));
	if (!(await buildVenv(base, venv, stale))) return base; // venv unavailable: use the base
	return planned.python;
}

/**
 * Build the venv, preferring uv.
 *
 * uv is ~50 ms against `python -m venv`'s couple of seconds, and its global
 * cache hardlinks, so the second notebook to install the same pandas costs
 * almost no time and almost no disk — which is what makes a venv per
 * notebook affordable at all. The venv it builds has no pip in it; that is
 * already handled, see `_pip` in `py/protocol.py`.
 */
async function buildVenv(base: string, dir: string, clear: boolean): Promise<boolean> {
	if (clear) rmSync(dir, { recursive: true, force: true });
	const uv = await capture("uv", ["venv", "--python", base, dir]);
	if (uv.status === 0) return true;
	return (await capture(base, ["-m", "venv", dir])).status === 0;
}

/**
 * Keep a venv out of the commit when someone points `venvRoot` back inside
 * the repository — a container volume or a faster disk are both good reasons
 * to, and neither is a reason to commit 400 MB of unrelocatable symlinks.
 *
 * `.git/info/exclude` rather than `.gitignore`, for the reasons
 * pi-issue-tracker's `ensureDatabaseIgnored` gives: it is repo-local, is not
 * itself tracked, needs no commit and shows up in nobody's diff. With the
 * default root this does nothing at all, which is the point of that default.
 */
async function ensureVenvIgnored(cwd: string, venvRoot: string): Promise<void> {
	const rel = relative(cwd, venvRoot);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return; // outside the tree

	const pattern = `/${rel.split(/[\\/]/).join("/")}/`;
	if ((await capture("git", ["check-ignore", "--quiet", rel], cwd)).status === 0) return;

	const common = await capture("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	if (common.status !== 0) return; // not a repository; nothing to keep out of it

	const excludeFile = join(common.stdout.trim(), "info", "exclude");
	try {
		mkdirSync(dirname(excludeFile), { recursive: true });
		const existing = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
		if (existing.split("\n").includes(pattern)) return;
		writeFileSync(excludeFile, `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}${pattern}\n`);
	} catch {
		/* best effort: an unwritable .git is not a reason to fail the call */
	}
}

export interface NotebookInfo {
	name: string;
	/** The checkpoint path, and whether it is there. */
	file: string;
	hasFile: boolean;
	/**
	 * Where its venv is (or would be), and whether it has been built. Both
	 * are about the venv this extension owns, not about what the notebook
	 * currently runs: a pin leaves an already-built venv on disk, and one
	 * that cannot be seen cannot be reclaimed.
	 */
	venv: string;
	hasVenv: boolean;
	/** The interpreter it would run under, and which rule chose it. */
	python: string;
	source: Planned["source"];
}

/**
 * Every notebook this project knows about: one with a checkpoint, one with
 * a venv, or both. A notebook that has been committed but never opened on
 * this machine shows up with `hasVenv: false`, which is exactly the state a
 * fresh clone is in.
 */
export function listNotebooks(cwd: string, opts: ConfigOpts = {}): NotebookInfo[] {
	const names = new Set<string>();
	const add = (name: string) => {
		if (!nameError(name)) names.add(name);
	};
	try {
		for (const entry of readdirSync(join(cwd, STATE_DIR, NOTEBOOKS_DIR))) {
			if (entry.endsWith(".py")) add(entry.slice(0, -".py".length));
		}
	} catch {
		/* no checkpoints yet */
	}
	try {
		for (const entry of readdirSync(join(resolveVenvRoot({ ...opts, cwd }), projectSlug(cwd)))) {
			add(entry);
		}
	} catch {
		/* no venvs yet */
	}
	return [...names].sort().map((name) => {
		const planned = plannedInterpreter(cwd, name, opts);
		const file = notebookFile(cwd, name);
		// `venv` from `venvDir` rather than from `planned`, which sets it only
		// on the venv branch: pinning is exactly what strands a built venv, so
		// reporting it only while nothing overrides it hides the ones most
		// worth reclaiming.
		const venv = venvDir(cwd, name, opts);
		return {
			name,
			file,
			hasFile: existsSync(file),
			venv,
			hasVenv: existsSync(join(venv, "bin", "python")),
			python: planned.python,
			source: planned.source,
		};
	});
}

/**
 * Delete a notebook's venv. Never touches the checkpoint — that is source.
 *
 * Resolved with `venvDir` rather than through `plannedInterpreter`: a pin
 * changes which interpreter *runs*, not which venv this extension owns, and
 * a venv that outlived the pin that stranded it is still the one to remove.
 * That also keeps it structurally unable to reach a pinned or system
 * interpreter — the path is always `<venvRoot>/<slug>/<name>`.
 */
export function dropVenv(cwd: string, notebook: string, opts: ConfigOpts = {}): string | null {
	const venv = venvDir(cwd, notebook, opts);
	if (!existsSync(venv)) return null;
	rmSync(venv, { recursive: true, force: true });
	return venv;
}

/**
 * The kernel's floor. `py/protocol.py` dispatches with `match`, which does
 * not parse below 3.10, so the interpreter cannot report its own
 * unsuitability — the only thing that would reach the agent is a
 * SyntaxError on stderr and a kernel that exited. It has to be checked
 * before the interpreter is ever handed the script. 3.12 rather than 3.10
 * to stay in step with pi-incremental-py and with `requires-python`.
 */
export const MIN_PYTHON: readonly [number, number] = [3, 12];

/** Spawn something, collect its output, and never throw. */
function capture(
	cmd: string,
	args: string[],
	cwd?: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		let proc: ChildProcess;
		try {
			proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			resolve({ status: null, stdout: "", stderr: "" });
			return;
		}
		let stdout = "";
		let stderr = "";
		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (c: string) => (stdout += c));
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (c: string) => (stderr += c));
		proc.on("error", () => resolve({ status: null, stdout, stderr }));
		proc.on("close", (code) => resolve({ status: code, stdout, stderr }));
	});
}

/** Version and absolute path of an interpreter, or null if it cannot be run. */
async function probe(
	python: string,
): Promise<{ version: [number, number]; executable: string } | null> {
	const out = await capture(python, [
		"-c",
		"import sys; print('%d.%d' % sys.version_info[:2]); print(sys.executable)",
	]);
	if (out.status !== 0) return null;
	const [reported, executable] = out.stdout.trim().split("\n");
	const [major, minor] = (reported ?? "").split(".").map(Number);
	if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
	return { version: [major, minor], executable: executable?.trim() || python };
}

/** `[major, minor]` of an interpreter, or null if it cannot be run at all. */
export async function interpreterVersion(python: string): Promise<[number, number] | null> {
	return (await probe(python))?.version ?? null;
}

function meetsFloor(version: [number, number] | null): boolean {
	if (!version) return false;
	const [major, minor] = version;
	return major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1]);
}

/**
 * An interpreter capable of bootstrapping a venv the kernel can run in.
 *
 * `python3` is tried first but is not trusted: on a machine where it is a conda
 * or system 3.9 the old code built the venv from it anyway, and every kernel
 * call then died on a SyntaxError from a perfectly healthy install. Versioned
 * names and uv's managed interpreter are the usual places a 3.12+ is hiding.
 *
 * The *resolved* `sys.executable` comes back rather than the name that found
 * it, because `uv venv --python` wants a path it can trust and not a word to
 * re-resolve against a different PATH.
 */
async function basePython(env: NodeJS.ProcessEnv): Promise<string | null> {
	if (env.PI_PYTHON) return env.PI_PYTHON;
	for (const candidate of ["python3", "python3.14", "python3.13", "python3.12"]) {
		const found = await probe(candidate);
		if (found && meetsFloor(found.version)) return found.executable;
	}
	const uv = await capture("uv", ["python", "find"]);
	if (uv.status === 0) {
		const found = await probe(uv.stdout.trim());
		if (found && meetsFloor(found.version)) return found.executable;
	}
	return null;
}

export class Kernel {
	private proc: ChildProcess | null = null;
	private buffer = "";
	private waiter: ((line: string) => void) | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	/** Set when the kernel had to be respawned; cleared after being read. */
	lostState = false;

	private readonly script: string;
	private readonly cwd: string;
	private readonly opts: ConfigOpts;
	private python: string | null = null;

	/** Which notebook this session is on, and so which venv it runs in. */
	notebook: string;

	constructor(script = join(PY_DIR, "protocol.py"), cwd = process.cwd(), opts: ConfigOpts = {}) {
		this.script = script;
		this.cwd = cwd;
		this.opts = opts;
		this.notebook = resolveDefaultNotebook({ ...opts, cwd });
	}

	/** The interpreter the live child is running, once there has been one. */
	get interpreter(): string | null {
		return this.python;
	}

	/** Where this session's checkpoint is written. */
	get checkpoint(): string {
		return notebookFile(this.cwd, this.notebook);
	}

	/**
	 * Switch notebooks: an error message, or null having done it.
	 *
	 * The kernel dies here rather than being reconfigured, because the
	 * interpreter is chosen at spawn time — and because a namespace carried
	 * across a switch would be the previous notebook's globals sitting under
	 * the new one's cells, which is the confusion this kernel exists to
	 * report rather than create.
	 */
	useNotebook(name: string): string | null {
		const bad = nameError(name);
		if (bad) return bad;
		if (name === this.notebook) return null;
		this.kill();
		this.notebook = name;
		this.python = null;
		return null;
	}

	/**
	 * The live child, or a message saying why there cannot be one.
	 */
	private async ensure(): Promise<ChildProcess | string> {
		if (this.proc && this.proc.exitCode === null) return this.proc;
		if (this.proc) this.lostState = true; // died between calls
		this.python = await resolvePython(this.cwd, this.notebook, this.opts);

		const version = await interpreterVersion(this.python);
		if (version && !meetsFloor(version)) {
			return (
				`python ${version[0]}.${version[1]} at ${this.python} is too old — ` +
				`the kernel needs ${MIN_PYTHON[0]}.${MIN_PYTHON[1]}+. Pin a newer one with ` +
				`/nb-python <path>, or set PI_PYTHON`
			);
		}

		const proc = spawn(this.python, [this.script, "--serve"], {
			stdio: ["pipe", "pipe", "inherit"],
			cwd: this.cwd,
			// Agg is matplotlib's headless renderer. Without it, the first cell
			// to `import matplotlib.pyplot` on a machine with a display picks an
			// interactive backend and blocks the kernel waiting on a GUI event
			// loop that nothing is running — and in a container it fails
			// outright. The kernel captures figures rather than showing them,
			// so there is never anything for an interactive backend to do.
			env: { ...process.env, MPLBACKEND: process.env.MPLBACKEND ?? "Agg" },
		});
		this.proc = proc;
		this.buffer = "";
		this.waiter = null;
		// A spawn that never starts — no python3 on PATH, an unusable pin —
		// emits 'error' and never 'exit'. Unhandled, that is an uncaught
		// exception on an EventEmitter, which takes the whole pi session down;
		// and since 'exit' does not fire, the waiter would otherwise sit there
		// for the full round-trip timeout. Answer it immediately instead, with
		// a message naming both what was tried and the ways out. The handle is
		// dropped too: a spawn that failed this way keeps exitCode === null, so
		// ensure() would otherwise hand the same dead child back forever.
		proc.on("error", (err: NodeJS.ErrnoException) => {
			if (this.proc !== proc) return; // a replaced child; not this call's business
			this.lostState = true;
			this.proc = null;
			const reason =
				err.code === "ENOENT"
					? `python not found: ${this.python}`
					: `could not start python (${this.python}): ${err.message}`;
			this.waiter?.(
				JSON.stringify({
					ok: false,
					error: `${reason} — install Python 3.12+, pin an interpreter with /nb-python <path>, or set PI_PYTHON`,
				}),
			);
		});
		proc.stdout!.setEncoding("utf8");
		proc.stdout!.on("data", (chunk: string) => {
			this.buffer += chunk;
			let nl: number;
			while ((nl = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, nl);
				this.buffer = this.buffer.slice(nl + 1);
				this.waiter?.(line);
			}
		});
		proc.on("exit", () => {
			// Only while this is still the live child. `kill()` drops the handle
			// and the next call spawns a replacement, but the dead process's
			// exit event arrives asynchronously — unguarded it answers the *new*
			// call's waiter with "kernel process exited" and reports a loss that
			// did not happen. (The same guard is missing in pi-incremental-py,
			// where `/py-python` kills the kernel deliberately.)
			if (this.proc !== proc) return;
			this.lostState = true;
			this.waiter?.(JSON.stringify({ ok: false, error: "kernel process exited" }));
		});
		return proc;
	}

	/** Serialised JSON-RPC: one in flight, the rest queue. */
	call(req: Record<string, unknown>): Promise<KernelResponse> {
		const run = this.queue.then(() => this.roundTrip(req));
		this.queue = run.catch(() => {});
		return run;
	}

	private async roundTrip(req: Record<string, unknown>): Promise<KernelResponse> {
		// Awaited before the timer is armed, deliberately: bootstrapping a venv
		// can take seconds, and that is setup rather than a cell that hung.
		const proc = await this.ensure();
		if (typeof proc === "string") return { ok: false, error: proc };
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.waiter = null;
				this.kill();
				resolve({ ok: false, internal: true, error: "kernel timed out" });
			}, 120_000);
			this.waiter = (line) => {
				clearTimeout(timer);
				this.waiter = null;
				try {
					resolve(JSON.parse(line) as KernelResponse);
				} catch {
					resolve({ ok: false, internal: true, error: `bad kernel output: ${line.slice(0, 200)}` });
				}
			};
			// The write races the spawn: a child that failed to start has a
			// stdin that is closed (or absent), and an EPIPE thrown from here
			// would escape as a rejected call rather than the error handler's
			// message. Let the 'error' listener answer instead.
			try {
				proc.stdin!.write(JSON.stringify(req) + "\n");
			} catch {
				/* answered by the 'error' or 'exit' listener */
			}
		});
	}

	kill(): void {
		this.proc?.kill();
		this.proc = null;
	}
}
