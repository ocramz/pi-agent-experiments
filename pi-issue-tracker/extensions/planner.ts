/**
 * `/plan-stories`, minus everything a test could have reached.
 *
 * The prompts, the reply parse and the transaction that writes the plan live in
 * `src/plan.ts`. What is left is the loop pi requires: a `BorderedLoader` the
 * user can abort, a `modelRegistry.complete` call per turn, `ctx.ui.input` for
 * clarifications, and the running token total on the footer.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
	type PlanItem,
	parsePlanResponse,
	persistPlan,
	planSystemPrompt,
	planUserContent,
	repairStoryGraph,
} from "../src/plan.ts";
import { addUsage, emptyUsage, formatUsage, hasUsage } from "../src/usage.ts";
import { ensureDb, isDbReady, refreshStatus } from "./runtime.ts";

/** Run `/plan-stories <goal>`. */
export async function runPlanner(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/plan-stories requires interactive mode", "error");
		return;
	}
	if (!isDbReady()) {
		ctx.ui.notify("Story DB not ready", "error");
		return;
	}
	const db = ensureDb();
	const goal = args.trim();
	if (!goal) {
		ctx.ui.notify("Usage: /plan-stories <high-level goal>", "error");
		return;
	}
	if (!ctx.model) {
		ctx.ui.notify("No model selected", "error");
		return;
	}

	let storiesJson: PlanItem[] | null = null;
	let clarifications: string[] | null = null;
	let turn = 0;
	const maxTurns = 3;

	// Planning is a command, so these tokens never reach the built-in footer
	// counter. Total them here and surface them ourselves.
	const usage = emptyUsage();
	// One id across turns so the shared system prompt can actually cache.
	const planSessionId = randomUUID();

	const reportUsage = () => {
		if (!hasUsage(usage)) return;
		ctx.ui.setStatus("issue-tracker-planning", `plan ${formatUsage(usage)}`);
	};

	while (turn < maxTurns && !storiesJson) {
		const systemPrompt = planSystemPrompt(turn, maxTurns);
		const contentText = planUserContent(goal, clarifications);

		// Run model call with persistent loader so the user sees activity and can abort
		type PlanTurn = { text: string | null; usage?: Usage; error?: string };
		const outcome = await ctx.ui.custom<PlanTurn | null>((tui, theme, _kb, done) => {
			// BorderedLoader's label is fixed at construction, but we build a new
			// one each turn — so running totals go straight into the message.
			const runningTotal = hasUsage(usage) ? ` · ${formatUsage(usage)} so far` : "";
			const loader = new BorderedLoader(
				tui,
				theme,
				`Planning stories (turn ${turn + 1}/${maxTurns}) using ${ctx.model!.id}…${runningTotal}`,
			);
			loader.onAbort = () => done(null);

			const doPlan = async (): Promise<PlanTurn> => {
				try {
					const response = await ctx.modelRegistry.complete(
						ctx.model!,
						{
							systemPrompt,
							messages: [
								{ role: "user" as const, content: [{ type: "text" as const, text: contentText }], timestamp: Date.now() },
							],
						},
						{ sessionId: planSessionId, signal: loader.signal },
					);
					// Aborted turns still burn tokens, so report usage before bailing.
					if (response.stopReason === "aborted") return { text: null, usage: response.usage };
					if (response.stopReason === "length") {
						return { text: null, usage: response.usage, error: "The model hit its output limit before finishing the plan. Try a narrower goal." };
					}
					const text = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n")
						.trim();
					return { text, usage: response.usage };
				} catch (err) {
					return { text: null, error: err instanceof Error ? err.message : String(err) };
				}
			};

			doPlan().then(done).catch((err) => done({ text: null, error: String(err) }));
			return loader;
		});

		// null only comes from the abort path; a failure carries an error string.
		if (outcome === null) {
			reportUsage();
			ctx.ui.notify(`Planning cancelled.${hasUsage(usage) ? ` Used ${formatUsage(usage)}.` : ""}`, "info");
			return;
		}
		addUsage(usage, outcome.usage);
		reportUsage();

		if (outcome.text === null) {
			ctx.ui.notify(`Planning failed: ${outcome.error ?? "unknown error"}`, "error");
			return;
		}
		const parsed = parsePlanResponse(outcome.text);
		if (parsed.kind === "unparseable") {
			// A reply that promised questions but carried neither them nor JSON
			// failed differently from one that was simply not JSON.
			ctx.ui.notify(
				parsed.announcedClarify ? "Could not parse plan response. Aborting." : "Could not parse JSON plan. Aborting.",
				"error",
			);
			return;
		}
		if (parsed.kind === "clarify") {
			// Ask user clarifications. The question goes in the TITLE — the
			// input component ignores its placeholder argument entirely.
			const qs = parsed.questions;
			const answers: string[] = [];
			for (let i = 0; i < qs.length; i++) {
				const q = qs[i];
				const ans = await ctx.ui.input(`Clarification ${i + 1}/${qs.length}: ${q}`, "");
				if (ans === undefined) {
					ctx.ui.notify("Planning cancelled", "info");
					return;
				}
				answers.push(`${q}\nAnswer: ${ans}`);
			}
			clarifications = answers;
		} else {
			storiesJson = parsed.items;
		}
		turn++;
	}

	if (!storiesJson || storiesJson.length === 0) {
		ctx.ui.notify("No stories generated after clarification loop.", "warning");
		return;
	}

	const { items, warnings } = repairStoryGraph(storiesJson);
	if (warnings.length > 0) {
		ctx.ui.notify(`Plan repaired:\n${warnings.join("\n")}`, "warning");
	}

	// Bypasses `transitionStatus` on purpose — see the note on persistPlan.
	const { rootId, createdIds } = persistPlan(db, goal, items);

	refreshStatus(ctx);
	const costNote = hasUsage(usage) ? `\nPlanning used ${formatUsage(usage)}.` : "";
	ctx.ui.notify(
		`Created epic #${rootId} with ${createdIds.length} stories. Use /stories to view.${costNote}`,
		"info",
	);
}
