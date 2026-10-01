/**
 * Child processes that must not outlive the session that started them.
 *
 * Three things learned from the pinned toolchain (test/lean/contract.test.ts
 * keeps them true):
 *
 *  - elan's `lake` proxy execs the real lake, so the pid we spawn *is* lake,
 *    and `lean --server` inherits its process group;
 *  - every `lean --worker` the server starts runs in a process group of its
 *    own, so killing lake's group alone does not reach them;
 *  - workers exit by themselves on stdin EOF once the server is gone.
 *
 * So a stop is: close stdin, SIGTERM the group, then SIGKILL the group and
 * every descendant snapshotted before the first signal. The snapshot is the
 * belt to EOF's braces — a worker wedged in a long elaboration is the one case
 * where waiting for EOF would leak a multi-gigabyte process.
 *
 * And one safety net for the case no handler sees: pi exiting without a
 * `session_shutdown` (an uncaught exception, `process.exit`). A `process.on
 * ("exit")` listener SIGKILLs every group still registered. It is installed
 * once per *process*, keyed on globalThis, because `/reload` re-imports this
 * module and a module-level flag would add a second listener every time.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";

export interface GroupHandle {
	readonly pid: number;
	readonly child: ChildProcess;
	/** Resolves once, when the process exits (never rejects). */
	readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	/** The last few KB of stderr, for error messages. */
	stderrTail(): string;
	/** Whether the process has exited. */
	readonly done: boolean;
}

interface Registry {
	pgids: Set<number>;
	installed: boolean;
}

const REGISTRY_KEY = Symbol.for("pi-lean4/process-groups");

function registry(): Registry {
	const g = globalThis as unknown as Record<symbol, Registry | undefined>;
	let reg = g[REGISTRY_KEY];
	if (!reg) {
		reg = { pgids: new Set(), installed: false };
		g[REGISTRY_KEY] = reg;
	}
	if (!reg.installed) {
		reg.installed = true;
		const live = reg;
		const onExit = () => {
			for (const pgid of live.pgids) {
				try {
					process.kill(-pgid, "SIGKILL");
				} catch {
					/* already gone */
				}
			}
		};
		(onExit as { piLean4?: boolean }).piLean4 = true;
		process.on("exit", onExit);
	}
	return reg;
}

/** Process groups this process still owns. For tests and `/lean status`. */
export function liveGroups(): ReadonlySet<number> {
	return registry().pgids;
}

/** The number of `exit` listeners this module has installed in this process. */
export function safetyNetCount(): number {
	return process.listeners("exit").filter((l) => (l as { piLean4?: boolean }).piLean4).length;
}

export function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether a process is still running. A zombie — killed, not yet reaped by
 * whichever ancestor inherited it — counts as gone: it holds no memory and
 * runs nothing, and `kill(pid, 0)` alone would report it alive.
 */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
	} catch {
		return true; // no /proc: trust kill(0)
	}
}

export interface SpawnOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Keep at most this many bytes of stderr. */
	stderrBytes?: number;
	/** Called with each stderr chunk (already captured in the tail). */
	onStderr?: (chunk: string) => void;
}

/**
 * Spawn `cmd` as the leader of a new process group, with every stream piped
 * and every error listened for: an unhandled `error` on a child or one of its
 * streams is an uncaught exception, and the process it would crash is pi.
 */
export function spawnGroup(cmd: string, args: string[], opts: SpawnOptions): GroupHandle {
	const reg = registry();
	const child = spawn(cmd, args, {
		cwd: opts.cwd,
		env: opts.env ?? process.env,
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const limit = opts.stderrBytes ?? 8192;
	let tail = "";
	let done = false;
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		tail = (tail + chunk).slice(-limit);
		opts.onStderr?.(chunk);
	});
	for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on("error", () => {});
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		let settled = false;
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			done = true;
			if (child.pid !== undefined) reg.pgids.delete(child.pid);
			resolve({ code, signal });
		};
		child.on("exit", finish);
		child.on("error", (err) => {
			tail = (tail + `\n${err.message}`).slice(-limit);
			// A spawn failure never emits "exit".
			if (child.pid === undefined || child.exitCode !== null) finish(child.exitCode ?? -1, null);
		});
	});
	if (child.pid !== undefined) {
		reg.pgids.add(child.pid);
		const pidfile = process.env.PI_LEAN4_PIDFILE;
		if (pidfile) {
			try {
				appendFileSync(pidfile, `${child.pid}\n`);
			} catch {
				/* a test hook, never a reason to fail */
			}
		}
	}
	return {
		get pid() {
			return child.pid ?? -1;
		},
		child,
		exited,
		stderrTail: () => tail,
		get done() {
			return done;
		},
	};
}

/**
 * Every descendant of `pid`, deepest last. Linux reads /proc; elsewhere `ps`.
 * Best effort: an empty list is a fine answer when neither is available.
 */
export function descendants(pid: number): number[] {
	const children = new Map<number, number[]>();
	const add = (child: number, parent: number) => {
		const list = children.get(parent);
		if (list) list.push(child);
		else children.set(parent, [child]);
	};
	let read = false;
	try {
		for (const entry of readdirSync("/proc")) {
			if (!/^\d+$/.test(entry)) continue;
			try {
				const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
				// The command name is parenthesised and may contain spaces.
				const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
				add(Number(entry), Number(after[1]));
			} catch {
				/* raced an exit */
			}
		}
		read = true;
	} catch {
		/* no /proc */
	}
	if (!read) {
		try {
			const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
			for (const line of out.split("\n")) {
				const [p, pp] = line.trim().split(/\s+/).map(Number);
				if (p && pp) add(p, pp);
			}
		} catch {
			return [];
		}
	}
	const out: number[] = [];
	const queue = [pid];
	while (queue.length) {
		const next = children.get(queue.shift()!) ?? [];
		out.push(...next);
		queue.push(...next);
	}
	return out;
}

/** A process's command line, or null when it is gone or cannot be read. */
export function processArgs(pid: number): string | null {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
	} catch {
		/* no /proc, or the process is gone */
	}
	try {
		return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
	} catch {
		return null;
	}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/**
 * Stop a group: stdin EOF, SIGTERM to the group, a grace period, then SIGKILL
 * to the group and to every descendant seen before the first signal.
 * Idempotent and safe on a process that is already gone.
 */
export async function killGroup(handle: GroupHandle, opts: { graceMs?: number } = {}): Promise<void> {
	const reg = registry();
	const pid = handle.pid;
	if (pid <= 0 || handle.done) {
		reg.pgids.delete(pid);
		return;
	}
	const family = descendants(pid);
	try {
		handle.child.stdin?.end();
	} catch {
		/* already closed */
	}
	const signal = (sig: NodeJS.Signals) => {
		try {
			process.kill(-pid, sig);
		} catch {
			/* group gone */
		}
	};
	signal("SIGTERM");
	await Promise.race([handle.exited, sleep(opts.graceMs ?? 2000)]);
	signal("SIGKILL");
	for (const d of family) {
		try {
			process.kill(d, "SIGKILL");
		} catch {
			/* already exited */
		}
	}
	await Promise.race([handle.exited, sleep(2000)]);
	// Wait (bounded) until the family is really gone, so that "stopped" means
	// the memory is back — not merely that the signals were sent.
	for (let i = 0; i < 40 && family.some(pidAlive); i++) await sleep(50);
	reg.pgids.delete(pid);
}
