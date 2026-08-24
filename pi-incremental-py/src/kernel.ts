/**
 * Long-lived Python kernel subprocess speaking the JSON-lines protocol.
 *
 * One Kernel per pi session, lazily spawned on first use. Calls are
 * serialised through a promise chain: the protocol is one-request /
 * one-response on a single pipe, so concurrent tool calls must queue.
 * If the process dies, the next call respawns it and flags the loss.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface KernelResponse {
	ok: boolean;
	error?: string;
	internal?: boolean;
	[key: string]: unknown;
}

const PY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "py");

/**
 * Which interpreter the kernel runs under, and therefore which
 * environment `py_install` installs into.
 *
 * Resolution order:
 *  1. `PI_PYTHON` env var (escape hatch, e.g. tests).
 *  2. A preexisting interpreter/venv pinned by the user in
 *     `<cwd>/.incremental/python-pin` (one line: a python binary or a venv
 *     directory). Written by the `/py-python` command.
 *  3. A venv the extension creates and owns at `<cwd>/.incremental/venv`,
 *     bootstrapped from `python3` on PATH and kept out of the user's way
 *     (`.incremental/` gets a `.gitignore` covering it).
 */
export function resolvePython(cwd: string): string {
	if (process.env.PI_PYTHON) return process.env.PI_PYTHON;

	const pinFile = join(cwd, ".incremental", "python-pin");
	if (existsSync(pinFile)) {
		const pin = readFileSync(pinFile, "utf8").trim();
		if (pin) {
			const asVenv = join(pin, "bin", "python");
			return existsSync(asVenv) ? asVenv : pin;
		}
	}

	const venvDir = join(cwd, ".incremental", "venv");
	const venvPython = join(venvDir, "bin", "python");
	// A venv already built from a too-old base is worse than no venv: it exists,
	// so it would be reused forever, and every kernel call dies on a SyntaxError
	// from an install that looks perfectly healthy. Rebuild it instead.
	const stale = existsSync(venvPython) && !meetsFloor(interpreterVersion(venvPython));
	if (!existsSync(venvPython) || stale) {
		const base = basePython();
		if (!base) return "python3"; // nothing to build from; let spawn fail loudly
		mkdirSync(join(cwd, ".incremental"), { recursive: true });
		// Keep the venv (and the pin file) out of git and pi's file tools.
		writeFileSync(join(cwd, ".incremental", ".gitignore"), "venv/\npython-pin\n");
		const made = spawnSync(base, ["-m", "venv", ...(stale ? ["--clear"] : []), venvDir], {
			encoding: "utf8",
		});
		if (made.status !== 0) return base; // venv unavailable: use the base as-is
	}
	return venvPython;
}

export function pinPython(cwd: string, interpreter: string): void {
	mkdirSync(join(cwd, ".incremental"), { recursive: true });
	writeFileSync(join(cwd, ".incremental", "python-pin"), interpreter + "\n");
}

export function pythonCommand(): string {
	return process.env.PI_PYTHON ?? "python3";
}

/**
 * The kernel's floor. `py/kernel.py` reads comprehension scopes the way PEP 709
 * made them in 3.12, and `py/protocol.py` uses `match`; on an older interpreter
 * the analysis is wrong rather than absent, and below 3.10 the module does not
 * even parse — which is why this cannot be a `sys.version_info` guard inside
 * the Python. It has to be checked before the interpreter is ever handed the
 * script.
 */
export const MIN_PYTHON: readonly [number, number] = [3, 12];

/** `[major, minor]` of an interpreter, or null if it cannot be run at all. */
export function interpreterVersion(python: string): [number, number] | null {
	const probe = spawnSync(python, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], {
		encoding: "utf8",
	});
	if (probe.status !== 0) return null;
	const [major, minor] = probe.stdout.trim().split(".").map(Number);
	return Number.isInteger(major) && Number.isInteger(minor) ? [major, minor] : null;
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
 */
function basePython(): string | null {
	if (process.env.PI_PYTHON) return process.env.PI_PYTHON;
	for (const candidate of ["python3", "python3.14", "python3.13", "python3.12"]) {
		if (meetsFloor(interpreterVersion(candidate))) return candidate;
	}
	const uv = spawnSync("uv", ["python", "find"], { encoding: "utf8" });
	if (uv.status === 0 && meetsFloor(interpreterVersion(uv.stdout.trim()))) return uv.stdout.trim();
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
	private python: string | null = null;

	constructor(script = join(PY_DIR, "protocol.py"), cwd = process.cwd()) {
		this.script = script;
		this.cwd = cwd;
	}

	/**
	 * The live child, or a message saying why there cannot be one.
	 *
	 * An interpreter below the floor cannot report its own unsuitability: the
	 * protocol module does not parse there, so the only thing that reaches the
	 * agent is a SyntaxError on stderr and a kernel that exited. Catch it here,
	 * where the version is knowable and the message can say what to do.
	 */
	private ensure(): ChildProcess | string {
		if (this.proc && this.proc.exitCode === null) return this.proc;
		if (this.proc) this.lostState = true; // died between calls
		this.python = resolvePython(this.cwd);

		const version = interpreterVersion(this.python);
		if (version && !meetsFloor(version)) {
			return (
				`python ${version[0]}.${version[1]} at ${this.python} is too old — ` +
				`the kernel needs ${MIN_PYTHON[0]}.${MIN_PYTHON[1]}+. Pin a newer one with ` +
				`/py-python <path>, or set PI_PYTHON`
			);
		}

		const proc = spawn(this.python, [this.script, "--serve"], {
			stdio: ["pipe", "pipe", "inherit"],
			cwd: this.cwd,
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
			this.lostState = true;
			if (this.proc === proc) this.proc = null;
			const reason =
				err.code === "ENOENT"
					? `python not found: ${this.python}`
					: `could not start python (${this.python}): ${err.message}`;
			this.waiter?.(
				JSON.stringify({
					ok: false,
					error: `${reason} — install Python 3.12+, pin an interpreter with /py-python <path>, or set PI_PYTHON`,
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

	private roundTrip(req: Record<string, unknown>): Promise<KernelResponse> {
		const proc = this.ensure();
		if (typeof proc === "string") return Promise.resolve({ ok: false, error: proc });
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
