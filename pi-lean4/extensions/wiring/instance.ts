/**
 * Everything one extension instance owns, and the rules about when it may be
 * used.
 *
 * pi builds a fresh instance (re-runs the factory) for every session it binds:
 * startup, /new, /resume, /fork, /reload. The previous instance gets
 * `session_shutdown` first, and after that every `pi.*` call on it throws. So:
 *
 *  - the runtime is created at `session_start`, never in the factory;
 *  - `session_shutdown` disposes it (killing the server) and marks the
 *    instance inactive, after which tools refuse rather than start a server
 *    nothing would ever stop;
 *  - nothing here is called from a child-process callback.
 */

import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ResolvedConfig, resolveConfig } from "../../src/config.ts";
import { LeanToolError } from "../../src/errors.ts";
import { LeanRuntime } from "../../src/lean/runtime.ts";
import { locate } from "../../src/lean/toolchain.ts";
import type { OpContext } from "../../src/ops/common.ts";
import { RateLimiter } from "../../src/ops/search/ratelimit.ts";
import { OFFLINE_FLAG, VERSION } from "../../src/tools.ts";

export const STATUS_KEY = "pi-lean4";

export class Instance {
	readonly pi: ExtensionAPI;
	active = false;
	limiter = new RateLimiter();
	cfg: ResolvedConfig = resolveConfig({});
	/** `/lean guardrails on|off` for this session; null = the configured value. */
	guardrailsOverride: boolean | null = null;
	#rt: LeanRuntime | null = null;
	#shutdown: Promise<void> | null = null;
	/** Extra status text from the autoprove loop, shown in the footer. */
	autoproveStatus: string | null = null;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	/** Re-read flag, env and (trusted) project settings. Cheap; done per call. */
	refreshConfig(ctx: ExtensionContext): ResolvedConfig {
		let offlineFlag: boolean | string | undefined;
		try {
			offlineFlag = this.pi.getFlag(OFFLINE_FLAG);
		} catch {
			offlineFlag = undefined;
		}
		this.cfg = resolveConfig({
			cwd: ctx.isProjectTrusted() ? ctx.cwd : undefined,
			overrides: offlineFlag === true ? { offline: true } : {},
		});
		return this.cfg;
	}

	get guardrails(): boolean {
		return this.guardrailsOverride ?? this.cfg.guardrails;
	}

	start(ctx: ExtensionContext): void {
		this.active = true;
		this.refreshConfig(ctx);
		this.#rt = new LeanRuntime({
			config: () => this.cfg,
			clientVersion: VERSION,
		});
	}

	/** The runtime, while the session is live. */
	runtime(): LeanRuntime {
		if (!this.active || !this.#rt) throw new LeanToolError("this pi session has ended; the Lean tools belong to the new one");
		return this.#rt;
	}

	/** The runtime if there is one, for questions that must not start anything. */
	peek(): LeanRuntime | null {
		return this.active ? this.#rt : null;
	}

	/** Idempotent: every shutdown reason takes this one path. */
	shutdown(): Promise<void> {
		if (this.#shutdown) return this.#shutdown;
		this.active = false;
		const rt = this.#rt;
		this.#rt = null;
		this.#shutdown = rt ? rt.dispose() : Promise.resolve();
		return this.#shutdown;
	}

	rgPath(): string | null {
		let extra: string[] = [];
		try {
			extra = [join(getAgentDir(), "bin")];
		} catch {
			extra = [];
		}
		return locate("rg", { explicit: this.cfg.rg, extraDirs: extra }).path;
	}

	opContext(ctx: ExtensionContext, signal: AbortSignal | undefined, onProgress?: (m: string) => void): OpContext {
		this.refreshConfig(ctx);
		return { cwd: ctx.cwd, cfg: this.cfg, signal, onProgress, rg: this.rgPath() };
	}

	/** Footer text: the server, if one is running, and the loop, if one is. */
	statusText(): string | undefined {
		const s = this.peek()?.status();
		const parts: string[] = [];
		if (s?.server?.alive) {
			const name = s.project?.name ?? s.server.root.split("/").pop();
			parts.push(`lean ● ${name} · ${s.server.openFiles.length} open`);
		}
		if (this.autoproveStatus) parts.push(this.autoproveStatus);
		if (this.cfg.offline && parts.length) parts.push("offline");
		return parts.length ? parts.join(" · ") : undefined;
	}

	refreshStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !this.active) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, this.statusText());
		} catch {
			/* a stale context: nothing to update */
		}
	}
}
