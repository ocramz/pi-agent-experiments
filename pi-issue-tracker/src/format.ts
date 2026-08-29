/**
 * Every string a story is rendered into.
 *
 * The sibling extensions all keep one of these (`pi-web-search/src/format.ts`,
 * `pi-incremental-py/src/format.ts`, `pi-notebook-py/src/format.ts`) so that the
 * index file calls a formatter rather than building prose inline. This one
 * arrived late: `storyToText` and the `/export-stories` markdown builder grew up
 * in `extensions/index.ts`, out of reach of `node --test`, and drifted into two
 * independent walks over the same field list.
 *
 * They are still two renderers — the plain-text one is read by a model, the
 * markdown one by a person, and their wording differs on purpose. What is shared
 * is `storyDetailFields`: *which* fields a story shows and *in what order*. That
 * was the part duplicated; the labels were not.
 */

import type { Story } from "./types.ts";

/** Statuses that mean the story is no longer work. */
export const CLOSED_STATUSES: readonly Story["status"][] = ["done", "cancelled", "archived"];

export function isOpen(story: Story): boolean {
	return !CLOSED_STATUSES.includes(story.status);
}

export function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The detail fields a story carries, in the order every renderer shows them.
 *
 * Presence rules live here and nowhere else. Each renderer switches on the key
 * and owns its own labels and value formatting — `depends_on` is `1, 2` in text
 * and `#1, #2` in markdown, and both are deliberate.
 */
export type StoryFieldKey =
	| "sub_goal"
	| "proposed_changes"
	| "parent"
	| "depends_on"
	| "next"
	| "resolution"
	| "learnings"
	| "review_plan"
	| "review_work"
	| "handoff_notes";

export function storyDetailFields(story: Story): StoryFieldKey[] {
	const fields: StoryFieldKey[] = ["sub_goal", "proposed_changes"];
	if (story.parent_id) fields.push("parent");
	if (story.depends_on.length) fields.push("depends_on");
	if (story.next_id) fields.push("next");
	if (story.resolution) fields.push("resolution");
	if (story.learnings) fields.push("learnings");
	if (story.review.plan) fields.push("review_plan");
	if (story.review.work) fields.push("review_work");
	if (story.handoff_notes) fields.push("handoff_notes");
	return fields;
}

/**
 * A story as the model reads it.
 *
 * `compact` is the list/board form — one line, the sub-goal truncated onto it.
 * The full form is what `create`, `update`, `mark_in_progress` and `get_next`
 * return, and it is the only place several fields are ever shown to the agent.
 */
export function storyToText(story: Story, compact = true): string {
	const lines = [`#${story.id} [${story.status}] ${story.title}`];
	if (compact) {
		lines[0] += ` — ${truncate(story.sub_goal, 60)}`;
		return lines.join("\n");
	}

	for (const field of storyDetailFields(story)) {
		switch (field) {
			case "sub_goal":
				lines.push(`  Sub-goal: ${story.sub_goal}`);
				break;
			case "proposed_changes":
				lines.push("  Proposed changes:");
				for (const line of story.proposed_changes.split("\n")) lines.push(`    ${line}`);
				break;
			case "parent":
				lines.push(`  Parent: #${story.parent_id}`);
				break;
			case "depends_on":
				lines.push(`  Depends on: ${story.depends_on.join(", ")}`);
				break;
			case "next":
				lines.push(`  Next: #${story.next_id}`);
				break;
			case "resolution":
				lines.push(`  Resolution: ${story.resolution}${story.resolution_note ? ` — ${story.resolution_note}` : ""}`);
				break;
			case "learnings":
				lines.push(`  Learned: ${story.learnings}`);
				break;
			case "review_plan":
				lines.push(`  Plan review: ${story.review.plan!.verdict} (by ${story.review.plan!.by})`);
				break;
			case "review_work":
				lines.push(`  Work review: ${story.review.work!.verdict} (by ${story.review.work!.by})`);
				break;
			case "handoff_notes":
				lines.push(`  Handoff: ${story.handoff_notes}`);
				break;
		}
	}
	return lines.join("\n");
}

/**
 * Depth-first ordering, each epic followed by its children.
 * Guards against cycles — nothing in the tool path prevents A→B→A.
 */
export function treeOrder(stories: Story[]): { story: Story; depth: number }[] {
	const ids = new Set(stories.map((s) => s.id));
	const byParent = new Map<number | null, Story[]>();
	for (const s of stories) {
		// A parent outside this set is treated as a root so nothing is dropped.
		const key = s.parent_id !== null && ids.has(s.parent_id) ? s.parent_id : null;
		const bucket = byParent.get(key);
		if (bucket) bucket.push(s);
		else byParent.set(key, [s]);
	}

	const out: { story: Story; depth: number }[] = [];
	const seen = new Set<number>();
	const walk = (parent: number | null, depth: number) => {
		for (const s of byParent.get(parent) ?? []) {
			if (seen.has(s.id)) continue;
			seen.add(s.id);
			out.push({ story: s, depth });
			walk(s.id, depth + 1);
		}
	};
	walk(null, 0);

	// Anything unreachable (i.e. inside a cycle) is appended flat.
	for (const s of stories) {
		if (!seen.has(s.id)) out.push({ story: s, depth: 0 });
	}
	return out;
}

/**
 * The whole board as a markdown document, for `/export-stories`.
 *
 * Epics become sections and their children nest one heading level deeper, capped
 * at `######` because markdown has no seventh level.
 */
export function storiesToMarkdown(stories: Story[]): string {
	const lines: string[] = ["# User Stories", ""];
	for (const { story: s, depth } of treeOrder(stories)) {
		const marker = s.status === "in_progress" ? "▶" : s.status === "done" ? "✓" : s.status === "ready" ? "○" : "•";
		const heading = "#".repeat(Math.min(6, depth + 2));
		lines.push(`${heading} ${marker} #${s.id}: ${s.title}`);
		// Status is a heading field here but rides on the title line in
		// `storyToText`, so it sits outside the shared walk.
		lines.push(`**Status:** ${s.status}`);

		for (const field of storyDetailFields(s)) {
			switch (field) {
				case "sub_goal":
					lines.push(`**Sub-goal:** ${s.sub_goal}`);
					break;
				case "proposed_changes":
					lines.push("**Proposed changes:**");
					for (const change of s.proposed_changes.split("\n")) lines.push(`- ${change}`);
					break;
				case "parent":
					lines.push(`**Part of:** #${s.parent_id}`);
					break;
				case "depends_on":
					lines.push(`**Depends on:** ${s.depends_on.map((id) => `#${id}`).join(", ")}`);
					break;
				case "next":
					lines.push(`**Next →** #${s.next_id}`);
					break;
				case "resolution":
					lines.push(`**Resolution:** ${s.resolution}${s.resolution_note ? ` — ${s.resolution_note}` : ""}`);
					break;
				case "learnings":
					lines.push(`**Learned:** ${s.learnings}`);
					break;
				case "review_plan":
					lines.push(`**Plan review:** ${s.review.plan!.verdict} — by ${s.review.plan!.by}`);
					break;
				case "review_work":
					lines.push(`**Work review:** ${s.review.work!.verdict} — by ${s.review.work!.by}`);
					break;
				case "handoff_notes":
					lines.push(`**Handoff:** ${s.handoff_notes}`);
					break;
			}
		}
		lines.push("");
	}
	return lines.join("\n");
}
