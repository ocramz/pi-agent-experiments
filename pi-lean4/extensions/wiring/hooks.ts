/**
 * The two hooks on pi's built-in tools.
 *
 *  - tool_call on bash: the git guardrails (src/hooks/guardrails.ts), only
 *    inside a Lean tree — the same scope lean4-skills' hook used.
 *  - tool_result on edit/write: the auto-check. When the edited file is a
 *    .lean file of the project the running server is bound to, it is synced
 *    and checked (bounded by autoCheckTimeoutMs) and a compact summary is
 *    appended to the result. Mode "running" (the default) never starts a
 *    server for this — an edit should not pay a cold start; "always" does;
 *    "off" disables it. It never throws: a failed check appends one line.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isEditToolResult, isToolCallEventType, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { messageOf } from "../../src/errors.ts";
import { AUTOCHECK_TAG, autocheckSummary } from "../../src/hooks/autocheck.ts";
import { classify } from "../../src/hooks/guardrails.ts";
import { displayPath, findProjectRoot, resolveToolPath } from "../../src/lean/project.ts";
import { toItems } from "../../src/ops/diagnostics.ts";
import type { Instance } from "./instance.ts";

/** Any ancestor with lean-toolchain or a lakefile: guardrails.sh's scope test. */
export function inLeanTree(dir: string): boolean {
	let d = dir;
	for (;;) {
		if (["lean-toolchain", "lakefile.lean", "lakefile.toml"].some((f) => existsSync(join(d, f)))) return true;
		const up = dirname(d);
		if (up === d) return false;
		d = up;
	}
}

export function registerHooks(inst: Instance): void {
	const { pi } = inst;

	pi.on("tool_call", (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		if (!inst.active || !inst.guardrails) return;
		if (!inLeanTree(ctx.cwd)) return;
		const v = classify(String(event.input.command ?? ""));
		if (!v.blocked) return;
		return {
			block: true,
			reason:
				`Blocked by the Lean guardrails: ${v.reason} (${v.rule}). Uncommitted proof work would be lost. ` +
				"Undo your own changes with edit instead, or checkpoint first (the lean4-review skill's checkpoint); " +
				"if the human wants this, they can run it themselves or turn the guardrails off with /lean guardrails off.",
		};
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!(isEditToolResult(event) || isWriteToolResult(event)) || event.isError) return;
		if (!inst.active) return;
		const raw = event.input.path;
		if (typeof raw !== "string" || !raw.trim()) return;
		const file = resolveToolPath(raw, ctx.cwd);
		if (!file.endsWith(".lean")) return;
		const cfg = inst.refreshConfig(ctx);
		if (cfg.autoCheck === "off") return;
		const root = findProjectRoot(file);
		if (!root) return;
		const rt = inst.peek();
		if (!rt) return;
		if (cfg.autoCheck === "running" && rt.boundRoot() !== root) return;
		const shown = displayPath(file, ctx.cwd);
		let summary: string;
		try {
			const { value, notes } = await rt.use(
				root,
				(s) =>
					s.withDocument(
						file,
						async (d) => {
							const r = await d.diagnostics({ timeoutMs: cfg.autoCheckTimeoutMs, signal: ctx.signal });
							return { r, items: toItems(r.items, d.lines, cfg.maxOutputChars).items };
						},
						{ signal: ctx.signal },
					),
				{ signal: ctx.signal },
			);
			summary = [
				...notes.map((n) => `${AUTOCHECK_TAG} ${n}`),
				autocheckSummary(shown, value.items, { complete: value.r.complete, timeoutMs: cfg.autoCheckTimeoutMs, reopened: value.r.reopened }),
			].join("\n");
		} catch (err) {
			if (ctx.signal?.aborted) return;
			summary = `${AUTOCHECK_TAG} unavailable: ${messageOf(err).split("\n")[0]} (lean_diagnostics {path} to check by hand)`;
		} finally {
			inst.refreshStatus(ctx);
		}
		return { content: [...event.content, { type: "text" as const, text: summary }] };
	});
}
