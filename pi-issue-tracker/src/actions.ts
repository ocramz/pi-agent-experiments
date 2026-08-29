/**
 * The thirteen actions behind the `story` tool.
 *
 * The tool's *declaration* — its description, its guidelines, its TypeBox
 * schema — stays in `extensions/index.ts`, because that is what pi reads and
 * what a reader wants to find next to the tool's name. What lives here is what
 * each action does, which pi has no opinion about and which was reachable only
 * by paying a live model to call it.
 *
 * Nothing here touches pi. The two things an action cannot do for itself —
 * building a reviewer from the calling `ExtensionContext`, and repainting the
 * footer — arrive as `ActionDeps.reviewer` and leave as flags on `ActionResult`.
 */

import {
	createStory,
	deleteStories,
	getAllStories,
	getChildren,
	getStoriesByStatus,
	getStoryById,
	getMaxPriority,
	hasChildren,
	searchStories,
	setAppState,
	transaction,
	updateStory,
	wouldCreateCycle,
} from "./database.ts";
import { isOpen, storyToText } from "./format.ts";
import { decideReview, gatherFindings, type ReviewGate } from "./review.ts";
import { checkCanClose, checkCanStart, unmetDependencies } from "./rules.ts";
import { takeGitNotes, type TrackerSession } from "./session.ts";
import { closeCompletedParents, promoteNextStory, selectReadyStory, transitionStatus } from "./transitions.ts";
import type { ReviewerRunner } from "./context.ts";
import type { Story, StoryResolution, ReviewVerdict } from "./types.ts";

/**
 * The tool's parameters, as the actions see them.
 *
 * Deliberately a hand-written mirror of the TypeBox `StoryParams` in
 * `extensions/index.ts` rather than an inference from it: `typebox` is an
 * *optional* peer dependency and is not installed, so importing it here would
 * break `node --test` on a clean checkout. `index.ts` assigns its inferred
 * params to this type, which is what makes the compiler catch drift.
 */
export interface StoryActionParams {
	action: string;
	title?: string;
	sub_goal?: string;
	proposed_changes?: string;
	story_id?: number;
	status?: Story["status"];
	depends_on?: number[];
	next_story_id?: number | null;
	parent_story_id?: number | null;
	resolution?: StoryResolution;
	resolution_note?: string;
	learnings?: string;
	handoff_notes?: string;
	verdict?: ReviewVerdict;
	findings?: string;
	status_filter?: string;
	query?: string;
	ordered_ids?: number[];
	source_ids?: number[];
	merged_title?: string;
}

export interface ActionDeps {
	/**
	 * Built from the *calling* pi context's model registry, never cached — see
	 * src/context.ts. Null means self-review.
	 */
	reviewer: ReviewerRunner | null;
	signal?: AbortSignal;
}

export interface ActionResult {
	text: string;
	/** Folded into the tool response's `details`, which the live tier reads. */
	details: Record<string, unknown>;
	/** The open-story count on the footer may be stale. */
	refreshStatus?: boolean;
	/** Reviewer tokens were spent; the review status line needs repainting. */
	reviewed?: boolean;
}

const notFound = (action: string, id: number): ActionResult => ({
	text: `Story #${id} not found`,
	details: { action, error: "not found" },
});

const missingStoryId = (action: string): ActionResult => ({
	text: `Error: story_id required for ${action}`,
	details: { action, error: "missing story_id" },
});

const updateFailed = (action: string): ActionResult => ({
	text: "Update failed unexpectedly",
	details: { action, error: "update failed" },
});

/** Dispatch. Every branch returns an `ActionResult`; nothing throws. */
export async function runStoryAction(
	session: TrackerSession,
	params: StoryActionParams,
	deps: ActionDeps,
): Promise<ActionResult> {
	switch (params.action) {
		case "create":
			return createAction(session, params);
		case "update":
			return updateAction(session, params);
		case "delete":
			return deleteAction(session, params);
		case "review_plan":
		case "review_work":
			return reviewAction(session, params, deps, params.action === "review_plan" ? "plan" : "work");
		case "mark_in_progress":
			return markInProgressAction(session, params);
		case "list":
			return listAction(session, params);
		case "search":
			return searchAction(session, params);
		case "mark_done":
			return markDoneAction(session, params);
		case "get_next":
			return getNextAction(session, params);
		case "set_top_level":
			return setTopLevelAction(session, params);
		case "reorder":
			return reorderAction(session, params);
		case "simplify":
			return simplifyAction(session, params);
		default:
			return { text: `Unknown action: ${params.action}`, details: { action: params.action, error: "unknown" } };
	}
}

export function createAction(session: TrackerSession, params: StoryActionParams): ActionResult {
	const db = session.db;
	const action = params.action;

	if (!params.title || !params.sub_goal) {
		return { text: "Error: title and sub_goal are required for create", details: { action, error: "missing fields" } };
	}
	if (typeof params.parent_story_id === "number" && !getStoryById(db, params.parent_story_id)) {
		return {
			text: `Error: parent story #${params.parent_story_id} not found`,
			details: { action, error: "parent not found" },
		};
	}

	const story = createStory(db, {
		title: params.title,
		sub_goal: params.sub_goal,
		proposed_changes: params.proposed_changes ?? "",
		status: params.status ?? "draft",
		priority: getMaxPriority(db) + 1,
		parent_id: params.parent_story_id ?? null,
		next_id: params.next_story_id ?? null,
		depends_on: params.depends_on ?? [],
	});
	return {
		text: `Created story #${story.id}: ${story.title}\n\n${storyToText(story, false)}`,
		details: { action, story },
		refreshStatus: true,
	};
}

export async function updateAction(session: TrackerSession, params: StoryActionParams): Promise<ActionResult> {
	const db = session.db;
	const action = params.action;

	if (!params.story_id) return missingStoryId(action);

	// null is meaningful here (detach), so check for a number specifically.
	if (typeof params.parent_story_id === "number") {
		if (!getStoryById(db, params.parent_story_id)) {
			return {
				text: `Error: parent story #${params.parent_story_id} not found`,
				details: { action, error: "parent not found" },
			};
		}
		if (params.parent_story_id === params.story_id) {
			return { text: "Error: a story cannot be its own parent", details: { action, error: "self parent" } };
		}
		if (wouldCreateCycle(db, params.story_id, params.parent_story_id)) {
			return {
				text: `Error: parenting #${params.story_id} to #${params.parent_story_id} would create a cycle`,
				details: { action, error: "cycle" },
			};
		}
	}

	/**
	 * `update` writes any status with no gates, which is fine for bookkeeping
	 * moves but would make the review gates decorative: an agent refused by
	 * `mark_in_progress` could set the status here and carry on. A live run did
	 * exactly that.
	 *
	 * Only the two gated transitions are redirected. `draft`, `ready` and
	 * `archived` are bookkeeping, and `cancelled` is deliberately still allowed —
	 * abandoning a story is not the same act as declaring it finished, and it is
	 * the only way to cancel from the tool.
	 */
	if (params.status === "in_progress" || params.status === "done") {
		const target = params.status === "in_progress" ? "mark_in_progress" : "mark_done";
		return {
			text:
				`Cannot set status to ${params.status} with update — use ${target} instead.\n` +
				`It runs the checks this action skips (dependencies, review gates${params.status === "done" ? ", resolution and handoff notes" : ""}).`,
			details: { action, error: `status ${params.status} requires ${target}` },
		};
	}

	const story = await transitionStatus(session, params.story_id, {
		title: params.title,
		sub_goal: params.sub_goal,
		proposed_changes: params.proposed_changes,
		status: params.status,
		next_id: params.next_story_id,
		depends_on: params.depends_on,
		parent_id: params.parent_story_id,
		resolution: params.resolution,
		resolution_note: params.resolution_note,
		learnings: params.learnings,
	});
	if (!story) return notFound(action, params.story_id);

	return {
		text: `Updated story #${story.id}:\n${storyToText(story, false)}${takeGitNotes(session)}`,
		details: { action, story },
		refreshStatus: true,
	};
}

export function deleteAction(session: TrackerSession, params: StoryActionParams): ActionResult {
	const db = session.db;
	const action = params.action;

	if (!params.story_id) return missingStoryId(action);
	const story = getStoryById(db, params.story_id);
	if (!story) return notFound(action, params.story_id);

	// Detach children rather than leaving them pointing at a deleted row.
	const orphans = getChildren(db, params.story_id);
	for (const child of orphans) {
		updateStory(db, child.id, { parent_id: story.parent_id });
	}
	deleteStories(db, [params.story_id]);

	const reparented = orphans.length
		? `\nReparented ${orphans.length} child story(ies) to ${story.parent_id ? `#${story.parent_id}` : "top level"}.`
		: "";
	return {
		text: `Deleted story #${params.story_id}: ${story.title}${reparented}`,
		details: { action, deleted: story, reparented: orphans.length },
		refreshStatus: true,
	};
}

export async function reviewAction(
	session: TrackerSession,
	params: StoryActionParams,
	deps: ActionDeps,
	gate: ReviewGate,
): Promise<ActionResult> {
	const db = session.db;
	const action = params.action;

	if (!params.story_id) return missingStoryId(action);
	const story = getStoryById(db, params.story_id);
	if (!story) return notFound(action, params.story_id);

	const { findings, evidence } = await gatherFindings(session, story, gate);
	const outcome = await decideReview({
		gate,
		story,
		findings,
		evidence,
		reviewer: deps.reviewer,
		selfVerdict: params.verdict,
		selfFindings: params.findings,
		now: session.now,
		signal: deps.signal,
	});

	if (!outcome.ok) {
		// Not an error: the no-verdict call reports findings this way too.
		return { text: outcome.report, details: { action, findings, recorded: false }, reviewed: true };
	}

	// Written straight through updateStory, not transitionStatus — a review
	// records a judgement and changes no status, so it has no git effect to
	// hang off.
	const updated = updateStory(db, story.id, { review: { ...story.review, [gate]: outcome.record } });
	if (!updated) return { ...updateFailed(action), reviewed: true };

	const next =
		outcome.record.verdict === "approved"
			? gate === "plan"
				? `\n\nApproved — you may now mark_in_progress on #${story.id}.`
				: `\n\nApproved — you may now mark_done on #${story.id} with a resolution and handoff_notes.`
			: `\n\nChanges requested — address them and review again.`;
	return {
		text: `${gate === "plan" ? "Plan" : "Work"} review of #${story.id}: ${outcome.record.verdict.toUpperCase()} (by ${outcome.record.by})\n\n${outcome.record.findings}${next}`,
		details: { action, story: updated, review: outcome.record, recorded: true },
		reviewed: true,
	};
}

export async function markInProgressAction(
	session: TrackerSession,
	params: StoryActionParams,
): Promise<ActionResult> {
	const db = session.db;
	const action = params.action;

	if (!params.story_id) return missingStoryId(action);
	const story = getStoryById(db, params.story_id);
	if (!story) return notFound(action, params.story_id);

	const allowed = checkCanStart({
		story,
		isEpic: hasChildren(db, story.id),
		openChildren: getChildren(db, story.id).filter(isOpen),
		unmet: unmetDependencies(story, (id) => getStoryById(db, id)),
	});
	if (!allowed.ok) {
		return { text: allowed.message, details: { action, error: allowed.code, ...allowed.details } };
	}

	const updated = await transitionStatus(session, params.story_id, { status: "in_progress" });
	if (!updated) return updateFailed(action);

	return {
		text: `✓ Story #${updated.id} is now IN PROGRESS\n${storyToText(updated, false)}${takeGitNotes(session)}`,
		details: { action, story: updated },
		refreshStatus: true,
	};
}

const STATUSES = new Set<Story["status"]>(["draft", "ready", "in_progress", "done", "cancelled", "archived"]);

export function listAction(session: TrackerSession, params: StoryActionParams): ActionResult {
	const db = session.db;
	const action = params.action;

	// An unrecognised filter lists everything rather than nothing — a typo that
	// silently returned "No stories found." would read as an empty board.
	const stories =
		params.status_filter && STATUSES.has(params.status_filter as Story["status"])
			? getStoriesByStatus(db, params.status_filter as Story["status"])
			: getAllStories(db);

	if (stories.length === 0) return { text: "No stories found.", details: { action, stories: [] } };
	return { text: stories.map((s) => storyToText(s, false)).join("\n\n"), details: { action, stories } };
}

export function searchAction(session: TrackerSession, params: StoryActionParams): ActionResult {
	const action = params.action;
	if (!params.query) return { text: "Error: query required for search", details: { action, error: "missing query" } };

	const stories = searchStories(session.db, params.query);
	return {
		text: stories.length ? stories.map((s) => storyToText(s, false)).join("\n\n") : "No matches.",
		details: { action, stories },
	};
}

export async function markDoneAction(session: TrackerSession, params: StoryActionParams): Promise<ActionResult> {
	const db = session.db;
	const action = params.action;

	if (!params.story_id) return missingStoryId(action);
	const story = getStoryById(db, params.story_id);
	if (!story) return notFound(action, params.story_id);

	const allowed = checkCanClose({
		story,
		isEpic: hasChildren(db, story.id),
		openChildren: getChildren(db, story.id).filter(isOpen),
		unmet: unmetDependencies(story, (id) => getStoryById(db, id)),
		resolution: params.resolution,
		handoffNotes: params.handoff_notes,
	});
	if (!allowed.ok) {
		return { text: allowed.message, details: { action, error: allowed.code, ...allowed.details } };
	}

	const updated = await transitionStatus(session, params.story_id, {
		status: "done",
		resolution: params.resolution,
		resolution_note: params.resolution_note,
		learnings: params.learnings,
		// Non-null: checkCanClose refuses an absent or blank note above.
		handoff_notes: params.handoff_notes!.trim(),
	});
	if (!updated) return updateFailed(action);

	setAppState(db, "last_closed_story_id", String(updated.id));

	const { note: nextMsg } = await promoteNextStory(session, updated);
	const closedParents = await closeCompletedParents(session, updated.id);
	const epicMsg = closedParents.length
		? `\n\n>>> EPIC COMPLETE: ${closedParents.map((s) => `#${s.id} ${s.title}`).join(", ")}`
		: "";

	return {
		text: `✓ Story #${updated.id} marked as DONE (${updated.resolution}).${epicMsg}${nextMsg}${takeGitNotes(session)}`,
		details: { action, story: updated, nextMessage: nextMsg, closedEpics: closedParents },
		refreshStatus: true,
	};
}

export function getNextAction(session: TrackerSession, params: StoryActionParams): ActionResult {
	const action = params.action;
	const topReady = selectReadyStory(session.db);
	if (!topReady) return { text: "No ready stories available right now.", details: { action, story: null } };
	return {
		text: `Next story to work on:\n${storyToText(topReady, false)}`,
		details: { action, story: topReady },
	};
}

export function setTopLevelAction(session: TrackerSession, params: StoryActionParams): ActionResult {
	const db = session.db;
	const action = params.action;

	if (!params.story_id) return missingStoryId(action);
	const story = getStoryById(db, params.story_id);
	if (!story) return notFound(action, params.story_id);

	setAppState(db, "top_level_story_id", String(story.id));
	return { text: `Top-level story set to #${story.id}: ${story.title}`, details: { action, story } };
}

export function reorderAction(session: TrackerSession, params: StoryActionParams): ActionResult {
	const db = session.db;
	const action = params.action;

	if (!params.ordered_ids || params.ordered_ids.length === 0) {
		return { text: "Error: ordered_ids required for reorder", details: { action, error: "missing ordered_ids" } };
	}
	// Every id is checked before anything is written — a partial reorder would
	// leave the chain pointing at rows the caller never named.
	for (const id of params.ordered_ids) {
		if (!getStoryById(db, id)) return notFound(action, id);
	}

	for (let i = 0; i < params.ordered_ids.length; i++) {
		const id = params.ordered_ids[i];
		const nextId = i + 1 < params.ordered_ids.length ? params.ordered_ids[i + 1] : null;
		updateStory(db, id, { priority: i, next_id: nextId });
	}

	const reordered = params.ordered_ids.map((id) => getStoryById(db, id)!);
	return {
		text: `Reordered ${reordered.length} stories. New order:\n${reordered.map((s) => `#${s.id}: ${s.title}`).join("\n")}`,
		details: { action, stories: reordered },
	};
}

export function simplifyAction(session: TrackerSession, params: StoryActionParams): ActionResult {
	const db = session.db;
	const action = params.action;

	if (!params.source_ids || params.source_ids.length < 2) {
		return { text: "Error: simplify requires at least 2 source_ids", details: { action, error: "not enough sources" } };
	}
	const sources = params.source_ids.map((id) => getStoryById(db, id)).filter(Boolean) as Story[];
	if (sources.length < 2) {
		return { text: "Error: could not locate all source stories", details: { action, error: "missing sources" } };
	}

	const mergedTitle = params.merged_title ?? `Merged: ${sources.map((s) => s.title).join(" + ")}`;
	const mergedSubGoal = sources.map((s) => s.sub_goal).join("\n");
	const mergedChanges = sources.map((s) => s.proposed_changes).join("\n---\n");
	const first = sources[0];
	const sourceIds = new Set(sources.map((s) => s.id));
	// Keep the epic when every source sat under the same one.
	const sharedParent = sources.every((s) => s.parent_id === first.parent_id) ? first.parent_id : null;

	const merged = transaction(db, () => {
		const created = createStory(db, {
			title: mergedTitle,
			sub_goal: mergedSubGoal,
			proposed_changes: mergedChanges,
			status: first.status === "done" ? "done" : first.status === "in_progress" ? "in_progress" : "ready",
			priority: first.priority,
			parent_id: sharedParent,
			next_id: first.next_id,
			// A merge must not depend on the parts it absorbed.
			depends_on: [...new Set(sources.flatMap((s) => s.depends_on))].filter((id) => !sourceIds.has(id)),
		});

		for (const s of sources) {
			// Adopt the sources' children so they aren't stranded on archived rows.
			for (const child of getChildren(db, s.id)) {
				if (child.id !== created.id) {
					updateStory(db, child.id, { parent_id: created.id });
				}
			}
			// Deliberately not transitionStatus: this runs inside a SQLite
			// transaction, which cannot hold open across a git subprocess. It is
			// also bookkeeping rather than work finishing — these stories never had
			// a commit, so archiving them must not produce one out of whatever
			// happens to be in the tree.
			updateStory(db, s.id, {
				status: "archived",
				resolution: "superseded",
				resolution_note: `Merged into #${created.id}`,
			});
		}

		// Repoint anyone depending on a source; archived never becomes done, so
		// those dependents would otherwise be blocked forever.
		for (const other of getAllStories(db)) {
			if (other.id === created.id || sourceIds.has(other.id)) continue;
			if (!other.depends_on.some((id) => sourceIds.has(id))) continue;
			const rewritten = [...new Set(other.depends_on.map((id) => (sourceIds.has(id) ? created.id : id)))];
			updateStory(db, other.id, { depends_on: rewritten });
		}

		return created;
	});

	return {
		text: `Simplified ${sources.length} stories into #${merged.id}: ${merged.title}\n\nSources archived: ${sources.map((s) => `#${s.id}`).join(", ")}\n\n${storyToText(merged, false)}`,
		details: { action, merged, sources },
		refreshStatus: true,
	};
}
