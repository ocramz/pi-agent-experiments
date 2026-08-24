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

	const venvPython = join(cwd, ".incremental", "venv", "bin", "python");
	if (!existsSync(venvPython)) {
		const base = basePython();
		if (!base) return "python3"; // nothing to build from; let spawn fail loudly
		mkdirSync(join(cwd, ".incremental"), { recursive: true });
		// Keep the venv (and the pin file) out of git and pi's file tools.
		writeFileSync(join(cwd, ".incremental", ".gitignore"), "venv/\npython-pin\n");
		const made = spawnSync(base, ["-m", "venv", join(cwd, ".incremental", "venv")], {
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

/** An interpreter capable of bootstrapping a venv (python3, else uv's). */
function basePython(): string | null {
	if (process.env.PI_PYTHON) return process.env.PI_PYTHON;
	if (spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0) return "python3";
	const uv = spawnSync("uv", ["python", "find"], { encoding: "utf8" });
	if (uv.status === 0) return uv.stdout.trim();
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

	private ensure(): ChildProcess {
		if (this.proc && this.proc.exitCode === null) return this.proc;
		if (this.proc) this.lostState = true; // died between calls
		this.python = resolvePython(this.cwd);
		this.proc = spawn(this.python, [this.script, "--serve"], {
			stdio: ["pipe", "pipe", "inherit"],
			cwd: this.cwd,
		});
		this.buffer = "";
		this.waiter = null;
		this.proc.stdout!.setEncoding("utf8");
		this.proc.stdout!.on("data", (chunk: string) => {
			this.buffer += chunk;
			let nl: number;
			while ((nl = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, nl);
				this.buffer = this.buffer.slice(nl + 1);
				this.waiter?.(line);
			}
		});
		this.proc.on("exit", () => {
			this.lostState = true;
			this.waiter?.(JSON.stringify({ ok: false, error: "kernel process exited" }));
		});
		return this.proc;
	}

	/** Serialised JSON-RPC: one in flight, the rest queue. */
	call(req: Record<string, unknown>): Promise<KernelResponse> {
		const run = this.queue.then(() => this.roundTrip(req));
		this.queue = run.catch(() => {});
		return run;
	}

	private roundTrip(req: Record<string, unknown>): Promise<KernelResponse> {
		const proc = this.ensure();
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
			proc.stdin!.write(JSON.stringify(req) + "\n");
		});
	}

	kill(): void {
		this.proc?.kill();
		this.proc = null;
	}
}
