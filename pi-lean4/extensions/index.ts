/**
 * pi-lean4: Lean 4 theorem proving for the pi agent.
 *
 * Eight tools over one Lean language server per session (lean_diagnostics,
 * lean_goal, lean_nav, lean_attempt, lean_search, lean_verify, lean_build,
 * lean_analyze), the /lean command with its autoprove loop, an auto-check
 * appended to edits of .lean files, and git guardrails. The skills and prompt
 * templates ship beside this file through package.json's `pi` manifest.
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
import { OFFLINE_FLAG } from "../src/tools.ts";
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

	pi.on("session_start", (_event, ctx) => {
		inst.start(ctx);
		autoprove.restoreFrom(ctx);
		inst.refreshStatus(ctx);
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
