/**
 * At most one Lean server per extension instance, bound to one Lake project.
 *
 *  - **Lazy.** Nothing starts until a tool needs an answer; the factory and
 *    `session_start` never spawn anything (pi's docs forbid it: some pi
 *    invocations load extensions without ever starting a session).
 *  - **One.** Concurrent first calls serialise on the exclusive lease, so the
 *    second finds the server the first started — one spawn, ever, per root.
 *  - **Switching.** A call about another project drains the calls in flight
 *    (they hold shared leases), stops the old server and starts the new one,
 *    and says so in its result.
 *  - **Builds.** `lake build` writes the .oleans the server reads, so a build
 *    takes the exclusive lease and stops the server first; the next call
 *    starts a fresh one against the new build.
 *  - **Disposal.** `dispose()` aborts the lifetime signal — which kills any
 *    build or profile process group started under it — and stops the server.
 *    `session_shutdown` calls it for every reason pi has.
 */

import { DEFAULTS } from "../config.ts";
import { AbortError, LeanToolError } from "../errors.ts";
import { RwLock } from "../sync.ts";
import { type ProjectInfo, projectInfo } from "./project.ts";
import { LeanServer, type ServerOptions } from "./server.ts";
import { asError, checkProject, lakeMissing, locateElan } from "./preflight.ts";
import { capture, locate, toolchainInstalled } from "./toolchain.ts";

export interface RuntimeConfig {
	offline: boolean;
	lake?: string;
	maxOpenFiles: number;
	scratchSlots: number;
	requestTimeoutMs: number;
	elaborationTimeoutMs: number;
	startTimeoutMs: number;
}

export interface RuntimeOptions {
	/** Read on every start, so a settings change applies to the next server. */
	config: () => RuntimeConfig;
	clientVersion: string;
	env?: NodeJS.ProcessEnv;
	/** Replace `lake serve` (the unit tier's fake server). */
	command?: (root: string) => { cmd: string; args: string[] };
	/** Skip the toolchain preflight (the fake server has no toolchain). */
	skipPreflight?: boolean;
	log?: (line: string) => void;
}

export interface UseOptions {
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export interface RuntimeStatus {
	server: ReturnType<LeanServer["status"]> | null;
	project: ProjectInfo | null;
	/** Servers started by this runtime: 1 after the first call, +1 per crash, switch or restart. */
	starts: number;
	lastExit: string | null;
	disposed: boolean;
}

const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;

export class LeanRuntime {
	#opts: RuntimeOptions;
	#lock = new RwLock();
	#server: LeanServer | null = null;
	#project: ProjectInfo | null = null;
	#lifetime = new AbortController();
	#crashes: number[] = [];
	#starts = 0;
	#lastExit: string | null = null;
	#unplanned: string | null = null;
	#disposed = false;

	constructor(opts: RuntimeOptions) {
		this.#opts = opts;
	}

	/** Aborted on dispose. Long-running children (build, profile) are tied to it. */
	get lifetime(): AbortSignal {
		return this.#lifetime.signal;
	}

	/** The server, if one is running. Never starts one. */
	running(): LeanServer | null {
		return this.#server?.alive ? this.#server : null;
	}

	boundRoot(): string | null {
		return this.running()?.root ?? null;
	}

	status(): RuntimeStatus {
		return {
			server: this.#server?.status() ?? null,
			project: this.#project,
			starts: this.#starts,
			lastExit: this.#lastExit,
			disposed: this.#disposed,
		};
	}

	/**
	 * Run `fn` with a live server for `root`, starting or switching as needed.
	 * Returns notes the tool result should carry (a switch, a restart).
	 */
	async use<T>(root: string, fn: (server: LeanServer) => Promise<T>, o: UseOptions = {}): Promise<{ value: T; notes: string[] }> {
		const notes: string[] = [];
		for (;;) {
			this.#assertLive();
			const release = await this.#lock.shared(o.signal);
			if (this.#server?.alive && this.#server.root === root) {
				try {
					return { value: await fn(this.#server), notes };
				} finally {
					release();
				}
			}
			release();
			const exclusive = await this.#lock.exclusive(o.signal);
			try {
				this.#assertLive();
				if (!(this.#server?.alive && this.#server.root === root)) {
					const previous = this.#server;
					if (previous?.alive) {
						notes.push(
							`Note: the Lean server moved from ${previous.root} to ${root} (one server per session); ` +
								"files open in the old project were closed.",
						);
						await previous.stop("switching project");
					} else if (this.#unplanned) {
						notes.push(`Note: ${this.#unplanned}. It was restarted; files were reopened from disk.`);
						this.#unplanned = null;
					}
					this.#server = null;
					this.#server = await this.#start(root, o);
				}
			} finally {
				exclusive();
			}
		}
	}

	/** Run `fn` with no server running and no tool call in flight (a build). */
	async exclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		this.#assertLive();
		const release = await this.#lock.exclusive(signal);
		try {
			if (this.#server) {
				await this.#server.stop("making way for a build");
				this.#server = null;
			}
			return await fn();
		} finally {
			release();
		}
	}

	/** Stop the server; the next call starts a fresh one. */
	async restart(signal?: AbortSignal): Promise<boolean> {
		const release = await this.#lock.exclusive(signal);
		try {
			const had = this.#server !== null;
			await this.#server?.stop("restart requested");
			this.#server = null;
			this.#unplanned = null;
			return had;
		} finally {
			release();
		}
	}

	/** Stop the server, if any. Same as restart, named for the human command. */
	stop(signal?: AbortSignal): Promise<boolean> {
		return this.restart(signal);
	}

	/** Abort everything this runtime started and stop the server. Idempotent. */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#lifetime.abort(new AbortError("the session ended"));
		const server = this.#server;
		this.#server = null;
		await server?.stop("session ended");
	}

	#assertLive(): void {
		if (this.#disposed) throw new LeanToolError("the session that owned this Lean server has ended");
	}

	async #start(root: string, o: UseOptions): Promise<LeanServer> {
		const now = Date.now();
		this.#crashes = this.#crashes.filter((t) => now - t < CRASH_WINDOW_MS);
		if (this.#crashes.length > CRASH_LIMIT) {
			throw new LeanToolError(
				`the Lean server for ${root} crashed ${this.#crashes.length} times in the last minute; not restarting it again. ` +
					`Last exit: ${this.#lastExit ?? "unknown"}. Fix the cause (memory, a corrupt build: lean_build {clean: true}), ` +
					"then /lean restart.",
			);
		}
		const cfg = this.#opts.config();
		const env = this.#opts.env ?? process.env;
		const project = projectInfo(root);
		let command = this.#opts.command?.(root);
		if (!command) {
			const lake = locate("lake", { explicit: cfg.lake, env });
			if (!lake.path) throw new LeanToolError(asError(lakeMissing(lake, cfg, env)));
			command = { cmd: lake.path, args: ["serve"] };
			if (!this.#opts.skipPreflight) await this.#preflight(lake.path, project, cfg, env, o);
		}
		const opts: ServerOptions = {
			root,
			command,
			env,
			maxOpenFiles: cfg.maxOpenFiles,
			scratchSlots: cfg.scratchSlots,
			requestTimeoutMs: cfg.requestTimeoutMs,
			elaborationTimeoutMs: cfg.elaborationTimeoutMs,
			startTimeoutMs: cfg.startTimeoutMs,
			clientVersion: this.#opts.clientVersion,
			log: this.#opts.log,
		};
		o.onProgress?.(`starting the Lean server in ${root}`);
		const server = await LeanServer.start(opts, this.#lifetime.signal);
		this.#project = project;
		this.#starts++;
		server.onExit((reason) => {
			if (this.#server !== server) return; // a server we replaced on purpose
			this.#lastExit = reason;
			this.#unplanned = reason;
			this.#crashes.push(Date.now());
		});
		return server;
	}

	/**
	 * Before `lake serve`: make sure elan has the project's toolchain. Online, a
	 * missing one is installed here, visibly, rather than inside the server's
	 * start timeout; offline, it is refused — that download is a network call.
	 */
	async #preflight(lake: string, project: ProjectInfo, cfg: RuntimeConfig, env: NodeJS.ProcessEnv, o: UseOptions): Promise<void> {
		// The same checks the session-start report runs; an error-level one
		// (offline with something still to download) means the server must not
		// start, and the error says how to fix it.
		const blockers = checkProject(project.root, { ...DEFAULTS, ...cfg }, env, { path: lake, source: "runtime" }, locateElan(env)).filter(
			(f) => f.severity === "error",
		);
		if (blockers.length) throw new LeanToolError(blockers.map(asError).join("\n"));
		if (toolchainInstalled(project.toolchain, env)) return;
		o.onProgress?.(`installing ${project.toolchain} with elan (first use of this toolchain)`);
		const r = await capture(lake, ["--version"], {
			cwd: project.root,
			timeoutMs: 30 * 60_000,
			signal: AbortSignal.any([this.#lifetime.signal, ...(o.signal ? [o.signal] : [])]),
			env,
		});
		if (r.code !== 0) {
			throw new LeanToolError(
				`elan could not provide ${project.toolchain} for ${project.root}:\n${(r.stderr || r.stdout).trim().split("\n").slice(-10).join("\n")}`,
			);
		}
	}
}
