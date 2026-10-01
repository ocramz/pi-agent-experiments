/**
 * `/lean autoprove <file>`: the lean4-prove skill's cycle, repeated by the
 * extension until the file is done or a budget runs out.
 *
 * The loop is driven by pi's own events, so it runs in the same session the
 * human is watching and can be interrupted like any run:
 *
 *   kickoff     sendUserMessage("/skill:lean4-prove …") — the skill's full
 *               text is injected, not just its name
 *   agent_end   remember whether the run was aborted (Esc) or failed
 *   agent_settled  pi will not continue on its own: measure the file, ask
 *               the pure state machine (src/hooks/autoprove.ts), and either
 *               queue the next cycle or stop with a summary
 *   input       a new prompt typed while idle stops the loop; a message typed
 *               while the agent is streaming is guidance and is delivered
 *
 * State is appended to the session after every decision, so /resume, /fork
 * and /reload find it — as *paused*; nothing restarts on its own.
 */

import { readFileSync } from "node:fs";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LeanToolError, messageOf } from "../../src/errors.ts";
import {
	type AutoproveState,
	type Budget,
	type Measure,
	boundary,
	cycleText,
	isDone,
	kickoffText,
	parseArgs,
	pause,
	restore,
	resume,
	start,
	summaryText,
	userStop,
} from "../../src/hooks/autoprove.ts";
import { displayPath, requireLeanFile, resolveToolPath } from "../../src/lean/project.ts";
import { toItems } from "../../src/ops/diagnostics.ts";
import { findSorries } from "../../src/ops/sorries.ts";
import { AUTOPROVE_TYPE } from "../../src/tools.ts";
import type { Instance } from "./instance.ts";

const MEASURE_TIMEOUT_MS = 300_000;

export class Autoprove {
	#inst: Instance;
	state: AutoproveState | null = null;
	#lastRun: { aborted: boolean; error?: string } = { aborted: false };
	#deciding = false;
	#done: (() => void) | null = null;
	#cwd = process.cwd();

	constructor(inst: Instance) {
		this.#inst = inst;
	}

	get running(): boolean {
		return this.state?.status === "running";
	}

	#shown(): string {
		return this.state ? displayPath(this.state.file, this.#cwd) : "";
	}

	#save(): void {
		if (!this.state) return;
		try {
			this.#inst.pi.appendEntry(AUTOPROVE_TYPE, this.state);
		} catch {
			/* a stale instance cannot write; the last saved state stands */
		}
		const s = this.state;
		this.#inst.autoproveStatus =
			s.status === "running"
				? `autoprove ${s.cycles + 1}/${s.budget.maxCycles}${s.stuckStreak ? ` stuck ${s.stuckStreak}/${s.budget.maxStuck}` : ""}`
				: s.status === "paused"
					? `autoprove paused ${s.cycles}/${s.budget.maxCycles}`
					: null;
	}

	/** At session_start: pick up a loop from this branch, paused. */
	restoreFrom(ctx: ExtensionContext): void {
		this.#cwd = ctx.cwd;
		try {
			this.state = restore(ctx.sessionManager.getBranch(), Date.now());
		} catch {
			this.state = null;
		}
		if (this.state?.status === "paused") {
			this.#save();
			if (ctx.hasUI) {
				ctx.ui.notify(
					`An autoprove loop on ${this.#shown()} was interrupted (${this.state.cycles} cycles done). /lean autoprove resume continues it.`,
					"info",
				);
			}
		}
	}

	async measure(file: string, root: string, signal?: AbortSignal): Promise<Measure> {
		const text = readFileSync(file, "utf8");
		const sorries = findSorries(text);
		const cfg = this.#inst.cfg;
		const { value } = await this.#inst.runtime().use(root, (s) =>
			s.withDocument(file, async (d) => {
				const r = await d.diagnostics({ timeoutMs: MEASURE_TIMEOUT_MS, signal });
				return toItems(r.items, d.lines, cfg.maxOutputChars).items;
			}),
		);
		const errors = value.filter((i) => i.severity === "error");
		const focus = errors[0]
			? `error at line ${errors[0].line}: ${errors[0].message.split("\n")[0].slice(0, 160)}`
			: sorries[0]
				? `sorry at line ${sorries[0].line} in ${sorries[0].declaration}`
				: null;
		return { sorries: sorries.length, errors: errors.length, focus };
	}

	async begin(args: string, ctx: ExtensionCommandContext, notify: (m: string, level?: "info" | "warning" | "error") => void): Promise<void> {
		this.#cwd = ctx.cwd;
		const cfg = this.#inst.cfg;
		const defaults: Budget = {
			maxCycles: cfg.autoprove.maxCycles,
			maxStuck: cfg.autoprove.maxStuckCycles,
			maxRuntimeMs: cfg.autoprove.maxRuntimeMinutes * 60_000,
		};
		const parsed = parseArgs(args, defaults);
		if (parsed.error) return notify(`/lean autoprove: ${parsed.error}`, "error");
		if (this.running) return notify(`autoprove is already running on ${this.#shown()}; /lean stop-autoprove first`, "warning");

		if (parsed.resume) {
			if (!this.state || this.state.status !== "paused") return notify("there is no paused autoprove loop to resume", "warning");
			await ctx.waitForIdle();
			this.state = resume(this.state, Date.now());
			this.#lastRun = { aborted: false };
			const m = await this.measure(this.state.file, this.state.root, ctx.signal);
			this.state = { ...this.state, last: m };
			this.#save();
			this.#inst.refreshStatus(ctx);
			this.#inst.pi.sendUserMessage(`/skill:lean4-prove ${cycleText(this.state, this.#shown())}`, { expandPromptTemplates: true });
			return this.#awaitHeadless(ctx);
		}

		if (!parsed.file) return notify("usage: /lean autoprove <file.lean> [--max-cycles=N] [--max-stuck=N] [--max-runtime=90m] | resume", "warning");
		let file: string;
		let root: string;
		try {
			({ file, root } = requireLeanFile(resolveToolPath(parsed.file, ctx.cwd)));
		} catch (err) {
			return notify(`/lean autoprove: ${messageOf(err)}`, "error");
		}
		await ctx.waitForIdle();
		notify(`autoprove: measuring ${displayPath(file, ctx.cwd)}…`);
		let m: Measure;
		try {
			m = await this.measure(file, root, ctx.signal);
		} catch (err) {
			return notify(`/lean autoprove: ${err instanceof LeanToolError ? err.message : messageOf(err)}`, "error");
		}
		if (isDone(m)) return notify(`${displayPath(file, ctx.cwd)} has no sorry and no error: nothing to prove.`);
		this.state = start(file, root, m, parsed.budget, Date.now());
		this.#lastRun = { aborted: false };
		this.#save();
		this.#inst.refreshStatus(ctx);
		this.#inst.pi.sendUserMessage(`/skill:lean4-prove ${kickoffText(this.state, this.#shown())}`, { expandPromptTemplates: true });
		return this.#awaitHeadless(ctx);
	}

	/**
	 * In print mode the process exits when the command returns, so there the
	 * command waits for the loop — and then for the summary turn — to finish.
	 * With a UI it returns at once and the loop runs alongside the human.
	 */
	async #awaitHeadless(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.hasUI) return;
		await new Promise<void>((resolve) => {
			this.#done = resolve;
		});
		await ctx.waitForIdle();
	}

	onAgentEnd(messages: readonly unknown[]): void {
		if (!this.running) return;
		const last = [...messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
			| { stopReason?: string; errorMessage?: string }
			| undefined;
		this.#lastRun = {
			aborted: last?.stopReason === "aborted",
			error: last?.stopReason === "error" ? (last.errorMessage ?? "the model request failed") : undefined,
		};
	}

	async onSettled(ctx: ExtensionContext): Promise<void> {
		if (!this.running || this.#deciding || !this.state) return;
		this.#deciding = true;
		try {
			let m: Measure;
			try {
				m = await this.measure(this.state.file, this.state.root, ctx.signal);
			} catch (err) {
				this.#finish(userStop(this.state, Date.now(), `could not measure the file: ${messageOf(err)}`), ctx, false);
				return;
			}
			const run = this.#lastRun;
			this.#lastRun = { aborted: false };
			const d = boundary(this.state, m, run, Date.now());
			this.state = d.state;
			if (d.kind === "continue") {
				this.#save();
				this.#inst.refreshStatus(ctx);
				this.#inst.pi.sendMessage(
					{ customType: AUTOPROVE_TYPE, content: cycleText(this.state, this.#shown()), display: true, details: { cycle: this.state.cycles + 1 } },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				return;
			}
			// A model-written summary is worth a turn when the loop ended on its
			// own terms; after an interruption or a failure, the numbers will do.
			this.#finish(this.state, ctx, d.reason !== "user-stop" && d.reason !== "error");
		} finally {
			this.#deciding = false;
		}
	}

	onInput(source: string, streaming: string | undefined, ctx: ExtensionContext): void {
		if (!this.running || source !== "interactive" || streaming) return;
		if (!this.state) return;
		this.#finish(userStop(this.state, Date.now(), "a new prompt was typed"), ctx, false);
	}

	stopByUser(ctx: ExtensionContext): boolean {
		if (!this.state || this.state.status === "stopped") return false;
		const wasRunning = this.running;
		this.#finish(userStop(this.state, Date.now()), ctx, false);
		if (wasRunning && !ctx.isIdle()) ctx.abort();
		return true;
	}

	#finish(state: AutoproveState, ctx: ExtensionContext, summaryTurn: boolean): void {
		this.state = state;
		this.#save();
		this.#inst.refreshStatus(ctx);
		const text = summaryText(state, this.#shown());
		try {
			this.#inst.pi.sendMessage(
				{ customType: AUTOPROVE_TYPE, content: text, display: true, details: { stop: state.stop } },
				summaryTurn ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
			);
		} catch {
			/* stale */
		}
		if (ctx.hasUI) ctx.ui.notify(text.split("\n")[0], state.stop?.reason === "completion" ? "info" : "warning");
		const done = this.#done;
		this.#done = null;
		done?.();
	}

	/** session_shutdown: pause a live loop so a later session can resume it. */
	shutdown(): void {
		if (this.state?.status === "running") {
			this.state = pause(this.state, Date.now());
			this.#save();
		}
		const done = this.#done;
		this.#done = null;
		done?.();
	}
}
