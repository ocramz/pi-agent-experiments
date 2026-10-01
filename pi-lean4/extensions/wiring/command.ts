/**
 * `/lean`: the human's handle on the server and the loop.
 *
 *   /lean [status]            what is running, where lake/rg come from, config
 *   /lean restart | stop      replace or stop the server (the next call starts one)
 *   /lean build [--clean] [--fetch-cache] [--force]
 *   /lean autoprove <file> [--max-cycles=N] [--max-stuck=N] [--max-runtime=90m]
 *   /lean autoprove resume    continue a paused loop
 *   /lean stop-autoprove
 *   /lean guardrails on|off   for this session
 *
 * `status` never starts anything.
 */

import { join } from "node:path";
import { type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { messageOf } from "../../src/errors.ts";
import { formatForUser } from "../../src/lean/preflight.ts";
import { findProjectRoot, projectInfo } from "../../src/lean/project.ts";
import { liveGroups } from "../../src/lean/process.ts";
import { locate, toolchainInstalled } from "../../src/lean/toolchain.ts";
import { buildOp, fingerprint, loadStamp } from "../../src/ops/build.ts";
import { COMMAND, SUBCOMMANDS } from "../../src/tools.ts";
import type { Autoprove } from "./autoprove.ts";
import type { Instance } from "./instance.ts";

const HELP = [
	"/lean status — server, toolchain, setup check with fixes, configuration (starts nothing)",
	"/lean restart | /lean stop — replace or stop the Lean server",
	"/lean build [--clean] [--fetch-cache] [--force] — lake build (skipped if nothing changed)",
	"/lean autoprove <file> [--max-cycles=N] [--max-stuck=N] [--max-runtime=90m] — prove until done or out of budget",
	"/lean autoprove resume — continue a paused loop",
	"/lean stop-autoprove — stop the loop",
	"/lean guardrails on|off — git guardrails for this session",
].join("\n");

export function statusReport(inst: Instance, ctx: ExtensionCommandContext, autoprove: Autoprove): string {
	const cwd = ctx.cwd;
	const setup = inst.checkSetup(ctx);
	const cfg = inst.cfg;
	const rt = inst.peek();
	const s = rt?.status();
	const lines: string[] = [];
	const lake = locate("lake", { explicit: cfg.lake });
	const rg = locate("rg", { explicit: cfg.rg, extraDirs: [join(getAgentDir(), "bin")] });
	lines.push(`lake: ${lake.path ?? "NOT FOUND"} (${lake.source})`);
	lines.push(`rg:   ${rg.path ?? "NOT FOUND — local search unavailable"} (${rg.source})`);
	lines.push(formatForUser(setup));
	const root = findProjectRoot(cwd);
	if (root) {
		const p = projectInfo(root);
		lines.push(
			`project: ${root} (${p.lakefile}, ${p.toolchain ?? "no toolchain pinned"}${p.toolchain && !toolchainInstalled(p.toolchain) ? " — NOT INSTALLED, elan downloads it on first use" : ""})`,
		);
		const stamp = loadStamp(root);
		lines.push(`build: ${stamp === null ? "never built by lean_build" : stamp === fingerprint(root) ? "up to date with the last lean_build" : "sources changed since the last lean_build"}`);
	} else {
		lines.push("project: none (the working directory is not inside a Lake project)");
	}
	if (s?.server?.alive) {
		const up = Math.round((Date.now() - s.server.startedAt) / 1000);
		lines.push(`server: running, pid ${s.server.pid}, ${s.server.root}, up ${up}s`);
		for (const f of s.server.openFiles) lines.push(`  open: ${f.path} (v${f.version})`);
	} else {
		lines.push(`server: not running${s?.lastExit ? ` (last exit: ${s.lastExit.split("\n")[0]})` : ""} — starts on the first Lean tool call`);
	}
	lines.push(`process groups owned: ${liveGroups().size}`);
	lines.push(
		`offline: ${cfg.offline ? "on (no remote search, no cache download)" : "off"} · auto-check: ${cfg.autoCheck} · guardrails: ${inst.guardrails ? "on" : "off"}`,
	);
	const a = autoprove.state;
	if (a) {
		lines.push(
			`autoprove: ${a.status} on ${a.file} — cycle ${a.cycles}/${a.budget.maxCycles}, stuck ${a.stuckStreak}/${a.budget.maxStuck}, sorries ${a.baseline.sorries} → ${a.last.sorries}, errors ${a.baseline.errors} → ${a.last.errors}${a.stop ? ` (stopped: ${a.stop.reason})` : ""}`,
		);
	}
	return lines.join("\n");
}

export function registerCommand(inst: Instance, autoprove: Autoprove): void {
	inst.pi.registerCommand(COMMAND, {
		description: "Lean server and proving loop: /lean status | restart | stop | build | autoprove <file> | stop-autoprove | guardrails on|off",
		// Offer subcommands only while one is still being typed: once the word is
		// complete (or an argument follows) the popup must close, or Enter would
		// accept the completion instead of running the command.
		getArgumentCompletions: (prefix: string) => {
			const word = prefix.trimStart();
			if (/\s/.test(word) || (SUBCOMMANDS as readonly string[]).includes(word)) return null;
			const items = SUBCOMMANDS.filter((s) => s.startsWith(word)).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, level);
				else console.log(msg);
			};
			inst.refreshConfig(ctx);
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				switch (sub) {
					case "status":
						notify(statusReport(inst, ctx, autoprove));
						inst.refreshStatus(ctx);
						return;
					case "help":
						notify(HELP);
						return;
					case "restart":
					case "stop": {
						const had = await inst.runtime().stop(ctx.signal);
						notify(had ? `Lean server stopped; ${sub === "restart" ? "a fresh one starts on the next call" : "it starts again on the next Lean tool call"}.` : "no Lean server was running.");
						inst.refreshStatus(ctx);
						return;
					}
					case "build": {
						const r = await buildOp(
							inst.runtime(),
							{ clean: rest.includes("--clean"), fetchCache: rest.includes("--fetch-cache"), force: rest.includes("--force") },
							{ ...inst.opContext(ctx, ctx.signal), onProgress: (m) => ctx.hasUI && ctx.ui.setStatus("pi-lean4", `lean build ${m}`) },
						);
						notify(r.text, (r.details as { success?: boolean }).success === false ? "error" : "info");
						inst.refreshStatus(ctx);
						return;
					}
					case "autoprove":
						await autoprove.begin(rest.join(" "), ctx, notify);
						return;
					case "stop-autoprove":
						notify(autoprove.stopByUser(ctx) ? "autoprove stopped." : "no autoprove loop is running.");
						return;
					case "guardrails": {
						const v = rest[0];
						if (v !== "on" && v !== "off") return notify(`guardrails are ${inst.guardrails ? "on" : "off"}; /lean guardrails on|off`);
						inst.guardrailsOverride = v === "on";
						notify(`git guardrails ${v} for this session.`);
						return;
					}
					default:
						notify(`unknown subcommand ${sub}\n${HELP}`, "warning");
				}
			} catch (err) {
				notify(`/lean ${sub}: ${messageOf(err)}`, "error");
			}
		},
	});
}
