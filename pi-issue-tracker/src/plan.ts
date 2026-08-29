/**
 * The `/plan-stories` pipeline, minus the pi parts.
 *
 * What the command still owns is the loop: a `BorderedLoader`, a
 * `modelRegistry.complete` call, and `ctx.ui.input` for clarifications. What
 * lives here is everything that decides *what to ask*, *what came back* and
 * *what to write* — all of it deterministic, and none of it reachable from a
 * test while it sat in `extensions/index.ts`.
 */

import type { DatabaseSync } from "node:sqlite";
import { createStory, getMaxPriority, getStoryById, setAppState, transaction, updateStory } from "./database.ts";
import { truncate } from "./format.ts";
import { extractJsonArray } from "./json.ts";

export interface PlanItem {
	title: string;
	sub_goal: string;
	proposed_changes: string;
	depends_on?: number[];
	parent_index?: number | null;
}

/**
 * The goal itself becomes the root epic (see `persistPlan`), so the model is
 * asked only for leaf work — `parent_index` is for an optional *second* level.
 */
export const PLAN_SYSTEM_PROMPT =
	`You are a requirements assistant. The user wants to break down a high-level goal into user stories.\n\nOnly ask clarifying questions if the goal is genuinely ambiguous and you cannot produce a reasonable breakdown (e.g., missing critical constraints, conflicting requirements, or undefined scope). If the goal is reasonably clear, make sensible assumptions and respond ONLY with a JSON array of user stories.\n\nIf you MUST clarify, respond with a short list of 1-3 clarifying questions, prefixed by ">>> CLARIFY:". Each question must be meaningful and non-empty.\n\nOtherwise, respond ONLY with a JSON array of user stories. Each story must have:\n- title (string)\n- sub_goal (string, 1-2 sentences)\n- proposed_changes (string, bullet or numbered list of concrete code/file changes)\n- depends_on (array of 0-based indices referencing earlier array items; optional)\n- parent_index (number | null, 0-based index of an earlier item that groups this story; optional)\n\nThe overall goal is already tracked separately as the parent of everything you return, so do NOT emit a story for the goal itself. Use parent_index only when a group of stories forms a distinct sub-area worth grouping under one of your own items; leave it out otherwise.\n\nDo NOT include markdown code fences around the JSON. Keep it compact and valid JSON. If dependencies or parent references exist, ensure they reference earlier indices only.`;

/** The last turn forbids another round of questions, because there is no round left. */
export function planSystemPrompt(turn: number, maxTurns: number): string {
	return turn === maxTurns - 1
		? `${PLAN_SYSTEM_PROMPT}\n\nIMPORTANT: This is your final chance. Do NOT ask for clarification. Produce the JSON array directly.`
		: PLAN_SYSTEM_PROMPT;
}

export function planUserContent(goal: string, clarifications: string[] | null): string {
	if (!clarifications) return goal;
	return `Goal: ${goal}\n\nClarifications:\n${clarifications.join("\n")}`;
}

export type PlanResponse =
	| { kind: "plan"; items: PlanItem[] }
	| { kind: "clarify"; questions: string[] }
	/**
	 * `announcedClarify` distinguishes the two failure shapes the command reports
	 * differently: a reply that promised questions and delivered neither them nor
	 * JSON is a different kind of wrong from a reply that simply was not JSON.
	 */
	| { kind: "unparseable"; announcedClarify: boolean };

/**
 * What the model's reply was.
 *
 * The subtle case is a reply that announces `>>> CLARIFY` and then lists no
 * questions we can recognise. That is a malformed clarification, not a refusal,
 * and the reply may still hold the JSON array — so it falls through to a plan
 * parse rather than being reported as an error the user cannot act on.
 */
export function parsePlanResponse(text: string): PlanResponse {
	const announcedClarify = text.includes(">>> CLARIFY");
	if (announcedClarify) {
		const questions = text
			.split(">>> CLARIFY")[1]
			?.split("\n")
			.filter((l) => l.trim().startsWith("-") || /^\d+\./.test(l.trim()))
			.map((l) => l.replace(/^[-\d\.\s]+/, "").trim())
			.filter((q) => q.length > 0) ?? [];
		if (questions.length > 0) return { kind: "clarify", questions };
	}
	const items = parsePlan(text);
	return items ? { kind: "plan", items } : { kind: "unparseable", announcedClarify };
}

function parsePlan(text: string): PlanItem[] | null {
	try {
		return coercePlanItems(JSON.parse(extractJsonArray(text)));
	} catch {
		return null;
	}
}

/**
 * JSON.parse guarantees nothing about shape. Without this, a well-formed but
 * wrong-shaped response reaches createStory and trips a NOT NULL constraint
 * partway through the insert loop.
 */
export function coercePlanItems(parsed: unknown): PlanItem[] | null {
	if (!Array.isArray(parsed) || parsed.length === 0) return null;
	const items: PlanItem[] = [];
	for (const raw of parsed) {
		if (typeof raw !== "object" || raw === null) return null;
		const r = raw as Record<string, unknown>;
		if (typeof r.title !== "string" || !r.title.trim()) return null;
		if (typeof r.sub_goal !== "string" || !r.sub_goal.trim()) return null;
		items.push({
			title: r.title.trim(),
			sub_goal: r.sub_goal.trim(),
			proposed_changes: typeof r.proposed_changes === "string" ? r.proposed_changes : "",
			depends_on: Array.isArray(r.depends_on)
				? r.depends_on.filter((d): d is number => typeof d === "number")
				: [],
			parent_index: typeof r.parent_index === "number" ? r.parent_index : null,
		});
	}
	return items;
}

/**
 * Repair out-of-range references instead of discarding the whole plan.
 * A bad parent_index falls back to the goal epic; a bad dependency is dropped.
 */
export function repairStoryGraph(items: PlanItem[]): { items: PlanItem[]; warnings: string[] } {
	const warnings: string[] = [];
	const repaired = items.map((item, i) => {
		let parentIndex = item.parent_index ?? null;
		if (parentIndex != null && (parentIndex >= i || parentIndex < 0)) {
			warnings.push(`"${truncate(item.title, 40)}" had parent_index ${parentIndex}; re-parented to the goal.`);
			parentIndex = null;
		}
		const dependsOn = (item.depends_on ?? []).filter((dep) => {
			if (dep >= i || dep < 0) {
				warnings.push(`"${truncate(item.title, 40)}" dropped out-of-range dependency ${dep}.`);
				return false;
			}
			return true;
		});
		return { ...item, parent_index: parentIndex, depends_on: dependsOn };
	});
	return { items: repaired, warnings };
}

/**
 * Write a repaired plan to the database, in one transaction.
 *
 * Status is written with plain `updateStory` rather than `transitionStatus` for
 * two reasons, both of which must stay true of anything added here: a SQLite
 * transaction cannot stay open across a git subprocess, and `ready` has no git
 * effect — work starts at `in_progress`, which is where a commit is anchored.
 */
export function persistPlan(
	db: DatabaseSync,
	goal: string,
	items: PlanItem[],
): { rootId: number; createdIds: number[] } {
	// Keep this run's stories after any existing ones instead of restarting at 0.
	const basePriority = getMaxPriority(db) + 1;

	return transaction(db, () => {
		// The goal itself becomes the root epic. Without it there is no parent
		// for anything to attach to, which is why parent_id was always null.
		const root = createStory(db, {
			title: truncate(goal, 80),
			sub_goal: goal,
			proposed_changes: `Delivered by the child stories of this epic.`,
			status: "draft",
			priority: basePriority,
			parent_id: null,
			next_id: null,
			depends_on: [],
		});

		const ids: number[] = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const dependsOn = (item.depends_on ?? [])
				.map((idx) => ids[idx])
				.filter((id): id is number => id !== undefined);
			// Default to the root epic; parent_index overrides it with a sub-group.
			const parentId = item.parent_index != null ? ids[item.parent_index] ?? root.id : root.id;
			const story = createStory(db, {
				title: item.title,
				sub_goal: item.sub_goal,
				proposed_changes: item.proposed_changes,
				status: "draft",
				priority: basePriority + 1 + i,
				parent_id: parentId,
				// Linked in the second pass below; inside this transaction the
				// intermediate state is never externally visible.
				next_id: null,
				depends_on: dependsOn,
			});
			ids.push(story.id);
		}

		// Chain the children; the root epic stays out of the chain.
		for (let i = 0; i < ids.length; i++) {
			updateStory(db, ids[i], { next_id: i + 1 < ids.length ? ids[i + 1] : null });
		}

		// Give the agent something to pick up. Without this everything sits in
		// `draft` and the context injection reports NO ACTIVE WORK.
		const firstReady = ids.find((id) => (getStoryById(db, id)?.depends_on.length ?? 0) === 0);
		if (firstReady !== undefined) {
			updateStory(db, firstReady, { status: "ready" });
		}

		setAppState(db, "top_level_story_id", String(root.id));
		return { rootId: root.id, createdIds: ids };
	});
}
