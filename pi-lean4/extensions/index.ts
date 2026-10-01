/**
 * pi-lean4: Lean 4 theorem proving for the pi agent.
 *
 * Eight tools over one Lean language server per session (lean_diagnostics,
 * lean_goal, lean_nav, lean_attempt, lean_search, lean_verify, lean_build,
 * lean_analyze), the /lean command with its autoprove loop, an auto-check
 * appended to edits of .lean files, and git guardrails. The skills and prompt
 * templates ship beside this file through package.json's `pi` manifest.
 *
 * At session_start a setup check (src/lean/preflight.ts — file lookups only)
 * reports a missing lake, toolchain, ripgrep or Mathlib cache, with the fix, to
 * the human and, on its first turn, to the model.
 *
 * The server is started by the first tool call that needs it — never here,
 * never at session_start — and stopped at session_shutdown, whatever the
 * reason (quit, /new, /resume, /fork, /reload). If pi exits without that
 * event, a process-exit hook kills it (src/lean/process.ts).
 *
 * No logic lives here: everything worth testing is in src/, and this file's
 * only coverage is pi itself loading it (test/tui, test/lean).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fingerprintFindings, formatForAgent, formatForUser, worst } from "../src/lean/preflight.ts";
import { OFFLINE_FLAG, SETUP_TYPE } from "../src/tools.ts";
import { Autoprove } from "./wiring/autoprove.ts";
import { registerCommand } from "./wiring/command.ts";
import { registerHooks } from "./wiring/hooks.ts";
import { Instance, STATUS_KEY } from "./wiring/instance.ts";
import { registerTools } from "./wiring/tools.ts";

export default function (pi: ExtensionAPI) {
	const inst = new Instance(pi);
	const autoprove = new Autoprove(inst);

	pi.registerFlag(OFFLINE_FLAG, {
		description: "pi-lean4: no network — no remote lemma search, no Mathlib cache download, no toolchain download",
		type: "boolean",
		default: false,
	});

	registerTools(inst);
	registerHooks(inst);
	registerCommand(inst, autoprove);

	pi.on("session_start", (event, ctx) => {
		inst.start(ctx);
		autoprove.restoreFrom(ctx);
		// The setup check: file lookups only, nothing spawned. Shown to the human
		// on startup and /reload (a /new or /resume has already seen it); the
		// model hears about it on its first turn (before_agent_start below).
		const report = inst.checkSetup(ctx);
		if (report.findings.length && (event.reason === "startup" || event.reason === "reload")) {
			const text = formatForUser(report);
			const level = worst(report.findings) === "error" ? "error" : worst(report.findings) === "warning" ? "warning" : "info";
			if (ctx.hasUI) ctx.ui.notify(text, level);
			else if (level !== "info") console.error(text);
		}
		inst.refreshStatus(ctx);
	});

	// Tell the model about setup problems before it reaches for a tool that
	// cannot work — once, and again whenever the set of problems changes
	// (including when the user has fixed them).
	pi.on("before_agent_start", (_event, ctx) => {
		if (!inst.active) return;
		const report = inst.checkSetup(ctx);
		inst.refreshStatus(ctx);
		const key = fingerprintFindings(report);
		if (key === inst.agentToldAbout) return;
		inst.agentToldAbout = key;
		return { message: { customType: SETUP_TYPE, content: formatForAgent(report), display: false, details: { findings: report.findings } } };
	});

	pi.on("agent_end", (event) => autoprove.onAgentEnd(event.messages));
	pi.on("agent_settled", (_event, ctx) => autoprove.onSettled(ctx));
	pi.on("input", (event, ctx) => {
		autoprove.onInput(event.source, event.streamingBehavior, ctx);
		return { action: "continue" as const };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		autoprove.shutdown();
		await inst.shutdown();
		if (ctx.hasUI) {
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				/* the UI may already be gone */
			}
		}
	});
}
