/**
 * The story context injected ahead of every agent turn.
 *
 * This is the extension's largest single piece of prompt, and it rides on every
 * request — which is why every list here is capped and relevance-filtered. It
 * was also, until it moved out of `extensions/index.ts`, the largest piece of
 * untestable code in the package: a `before_agent_start` handler exists only
 * inside a running pi, so the only thing that ever read this block was a live
 * model, and the only way to check a section was to pay for a turn.
 *
 * pi *appends* what a handler returns and never replaces it — `convertToLlm`
 * re-sends every one on every request — so the `context` hook prunes all but the
 * newest with `pruneStaleInjections`. That is why this function is free to
 * describe the present tense without worrying about what it said last turn.
 */

import { getAllStories, getAppState, getStoriesByStatus, getStoryById, setAppState } from "./database.ts";
import { isOpen, truncate } from "./format.ts";
import { sessionEpic, type TrackerSession } from "./session.ts";
import { selectReadyStory } from "./transitions.ts";
import type { Story } from "./types.ts";

/**
 * The `customType` on every injected story context, shared by the producer here
 * and the pruner in the `context` hook so the two cannot drift.
 */
export const STORY_CONTEXT_TYPE = "story-context";

export interface StoryContextBlock {
	customType: string;
	content: string;
	display: true;
}

/** How many of the *other* in-progress stories are named before the list is cut. */
const OTHER_IN_PROGRESS_SHOWN = 5;

/**
 * Build the block, or null when there is nothing worth saying.
 *
 * Not pure: it drains `last_closed_story_id`, because "just completed" means
 * *since the previous turn* and the only place that can be observed is the turn
 * that reads it. Draining anywhere else would either repeat the line forever or
 * need a second hook to clear it.
 */
export function buildStoryContext(session: TrackerSession): StoryContextBlock | null {
	const db = session.db;
	const allOpen = getAllStories(db).filter(isOpen);

	// 1. Ready story to work on now — topologically ready, then by priority/id.
	//    Epics are containers, never units of work. Same selector `get_next` uses.
	const readyToWork = selectReadyStory(db);

	// 2. Top-level story (big picture)
	const topLevelIdRaw = getAppState(db, "top_level_story_id");
	const topLevelStory = topLevelIdRaw ? getStoryById(db, Number(topLevelIdRaw)) : null;

	// 3. Story just closed in the previous turn
	const lastClosedIdRaw = getAppState(db, "last_closed_story_id");
	const justClosed = lastClosedIdRaw ? getStoryById(db, Number(lastClosedIdRaw)) : null;
	if (lastClosedIdRaw) {
		setAppState(db, "last_closed_story_id", "");
	}

	// 4. Other in-progress stories
	const inProgressStories = getStoriesByStatus(db, "in_progress").sort(
		(a, b) => a.priority - b.priority || a.id - b.id,
	);
	const primaryFocus = readyToWork ?? inProgressStories[0] ?? null;
	const otherInProgress = inProgressStories.filter((s) => s.id !== primaryFocus?.id);

	const hasAnythingToShow =
		primaryFocus || topLevelStory || justClosed || otherInProgress.length > 0 || allOpen.length > 0;
	if (!hasAnythingToShow) return null;

	const lines: string[] = [">>> STORY CONTEXT"];

	const epicLine = (s: Story): string | null => {
		if (!s.parent_id) return null;
		const parent = getStoryById(db, s.parent_id);
		return parent ? `Part of: #${parent.id} ${parent.title}` : null;
	};

	if (readyToWork) {
		lines.push(`\n>>> NEXT UP — work on this now`);
		lines.push(`#${readyToWork.id}: ${readyToWork.title}`);
		const epic = epicLine(readyToWork);
		if (epic) lines.push(epic);
		lines.push(`Sub-goal: ${readyToWork.sub_goal}`);
		lines.push(`Changes: ${readyToWork.proposed_changes}`);
		if (readyToWork.depends_on.length) {
			lines.push(`Dependencies met: ${readyToWork.depends_on.map((id) => `#${id}`).join(", ")}`);
		}
	} else if (inProgressStories.length > 0) {
		const p = inProgressStories[0];
		lines.push(`\n>>> IN PROGRESS — continue working on this`);
		lines.push(`#${p.id}: ${p.title}`);
		const epic = epicLine(p);
		if (epic) lines.push(epic);
		lines.push(`Sub-goal: ${p.sub_goal}`);
		lines.push(`Changes: ${p.proposed_changes}`);
	} else {
		lines.push(`\n>>> NO ACTIVE WORK — no ready or in-progress stories`);
	}

	if (topLevelStory) {
		lines.push(`\n>>> BIG PICTURE`);
		lines.push(`#${topLevelStory.id}: ${topLevelStory.title}`);
		lines.push(`${topLevelStory.sub_goal}`);
	}

	if (justClosed) {
		lines.push(`\n>>> JUST COMPLETED (previous turn)`);
		lines.push(`#${justClosed.id}: ${justClosed.title}`);
	}

	if (otherInProgress.length > 0) {
		lines.push(`\n>>> ALSO IN PROGRESS`);
		for (const s of otherInProgress.slice(0, OTHER_IN_PROGRESS_SHOWN)) {
			lines.push(`  ▶ #${s.id}: ${s.title} — ${s.sub_goal.slice(0, 60)}${s.sub_goal.length > 60 ? "…" : ""}`);
		}
		if (otherInProgress.length > OTHER_IN_PROGRESS_SHOWN) {
			lines.push(`  ... ${otherInProgress.length - OTHER_IN_PROGRESS_SHOWN} more`);
		}
	}

	if (primaryFocus) {
		const related = session.related.findRelated(db, primaryFocus, 5);
		if (related.length > 0) {
			lines.push(`\n>>> RELATED STORIES`);
			for (const s of related) {
				lines.push(`  ◇ #${s.id}: ${s.title} — ${truncate(s.sub_goal, 60)}`);
			}
		}

		// Things earlier work discovered that contradicted its plan. Capped and
		// relevance-filtered — this rides on every turn's context.
		const lessons = session.related.findLearnings(db, primaryFocus, 3);
		if (lessons.length > 0) {
			lines.push(`\n>>> LESSONS FROM COMPLETED WORK — these contradicted an earlier plan; check they don't apply here`);
			for (const s of lessons) {
				lines.push(`  ⚠ #${s.id} ${s.title}: ${truncate(s.learnings ?? "", 200)}`);
			}
		}

		// What earlier work handed on. Same cap and same relevance filter as
		// lessons: this rides on every turn, so an unrelated note is pure noise.
		const handoffs = session.related.findHandoffs(db, primaryFocus, 3);
		if (handoffs.length > 0) {
			lines.push(`\n>>> HANDOFF NOTES FROM RELATED WORK — what the people who did this before left for you`);
			for (const s of handoffs) {
				lines.push(`  ↪ #${s.id} ${s.title}: ${truncate(s.handoff_notes ?? "", 300)}`);
			}
		}
	}

	// The review gates are enforced, so a story sitting unreviewed stalls
	// silently unless the next step is stated where the agent will read it.
	if (readyToWork && readyToWork.review.plan?.verdict !== "approved") {
		lines.push(`\n>>> BEFORE STARTING — #${readyToWork.id} needs a plan review: story{action:"review_plan", story_id:${readyToWork.id}}`);
	} else if (!readyToWork && inProgressStories[0] && inProgressStories[0].review.work?.verdict !== "approved") {
		const p = inProgressStories[0];
		lines.push(`\n>>> BEFORE CLOSING — #${p.id} needs a work review: story{action:"review_work", story_id:${p.id}}`);
	}

	const activeEpic = sessionEpic(session);
	if (activeEpic) {
		lines.push(`\n>>> EPIC BRANCH`);
		lines.push(`Working on ${activeEpic.branch} (started from ${activeEpic.base_branch}).`);
		if (activeEpic.mode === "worktree" && activeEpic.path) {
			// Worth stating: the agent is in a checkout of its own, and other
			// epics may be running in sibling directories it must not touch.
			lines.push(`This session is in a dedicated worktree at ${activeEpic.path}. Work only inside it.`);
		}
		lines.push(`Every story you close is committed automatically — do not commit by hand.`);
		lines.push(`Do not switch branches, reset --hard, or delete branches; that would strand the epic.`);
	}

	return { customType: STORY_CONTEXT_TYPE, content: lines.join("\n"), display: true };
}
