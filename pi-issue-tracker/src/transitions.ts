/**
 * The single write path for a story's `status`, and everything that hangs off it.
 *
 * Status used to be written from three unrelated places — the `mark_in_progress`
 * action, the ungated `update` action, and the board's key handler — so anything
 * that had to happen on a transition would have had to be repeated three times
 * and would still have been missed by the next new caller. Git side effects hang
 * off `transitionStatus`, and any *new* status writer must go through it.
 *
 * Two callers deliberately bypass it — the `simplify` action and
 * `persistPlan` — because both write status inside a SQLite transaction, which
 * cannot stay open across a git subprocess. Both are bookkeeping rather than
 * work starting or finishing, so neither has a git effect to miss. Each says so
 * at the call site.
 */

import type { DatabaseSync } from "node:sqlite";
import { getAllStories, getChildren, getStoriesByStatus, getStoryById, hasChildren, updateStory } from "./database.ts";
import { commitStory, findEpicForStory, recordStoryStartCommit, updateFromBase } from "./epic.ts";
import { isOpen } from "./format.ts";
import { pushGitNote, serializeGit, type TrackerSession } from "./session.ts";
import type { Story } from "./types.ts";

/**
 * Git side effects of a status change.
 *
 * Does nothing at all unless the story belongs to an epic that has been started
 * with `/start-epic` — git integration is opt-in, and a tracker used without it
 * behaves exactly as it did before.
 */
export async function applyTransitionEffects(
	session: TrackerSession,
	before: Story | null,
	after: Story,
): Promise<void> {
	const epic = findEpicForStory(session, after.id);
	if (!epic) return;

	const wasOpen = before ? isOpen(before) : true;
	const isEpicItself = after.id === epic.epic_id;

	// Starting work: remember where it began, so it can be undone later.
	if (after.status === "in_progress" && before?.status !== "in_progress") {
		await recordStoryStartCommit(session, after, epic);
	}

	// A unit of work closed: commit what it changed. Epics are containers and
	// never carry a commit of their own.
	if (wasOpen && !isOpen(after) && !isEpicItself && !hasChildren(session.db, after.id)) {
		const committed = await commitStory(session, after, epic);
		if (committed.note) pushGitNote(session, committed.note);
	}

	// The epic itself closed. Bring the base branch in now, while the agent is
	// still here to resolve conflicts; the merge into the base branch is a
	// separate, user-confirmed step and never happens on the agent's say-so.
	if (isEpicItself && wasOpen && !isOpen(after)) {
		const updated = await updateFromBase(session, epic);
		pushGitNote(session, updated.note);
		if (updated.ok) {
			pushGitNote(session, `Epic #${epic.epic_id} is ready to merge — run /merge-epic ${epic.epic_id}.`);
		} else if (updated.conflicts.length > 0) {
			session.sendToAgent(
				`Merging ${epic.base_branch} into ${epic.branch} left conflicts in:\n` +
					updated.conflicts.map((file) => `  - ${file}`).join("\n") +
					`\n\nResolve them, commit, then run /merge-epic ${epic.epic_id}.`,
			);
		}
	}
}

export async function transitionStatus(
	session: TrackerSession,
	storyId: number,
	updates: Partial<Omit<Story, "id" | "created_at" | "updated_at">>,
): Promise<Story | null> {
	const before = getStoryById(session.db, storyId);
	const after = updateStory(session.db, storyId, updates);
	if (!after) return null;

	try {
		await serializeGit(session, () => applyTransitionEffects(session, before, after));
	} catch (error) {
		// A git failure must not lose the status change that already succeeded.
		pushGitNote(session, `git side effect failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return after;
}

/**
 * Gather an epic's handoff note from its children's.
 *
 * An epic is closed by `closeCompletedParents`, not by `mark_done`, so nobody is
 * ever asked to write one for it — and an epic with no note would be a hole in
 * the middle of the tree exactly where the summary belongs. Rolling the
 * children's notes up means the memory accumulates upward instead of staying
 * scattered across leaves.
 */
export function rollUpHandoffNotes(epic: Story, children: Story[]): string {
	const notes = children
		.filter((child) => child.handoff_notes?.trim())
		.map((child) => `#${child.id} ${child.title}: ${child.handoff_notes!.trim()}`);
	if (notes.length === 0) {
		return `Epic "${epic.title}" closed with ${children.length} child stories; none recorded a handoff note.`;
	}
	return [`Epic "${epic.title}" — handoff notes from its ${notes.length} closed ${notes.length === 1 ? "story" : "stories"}:`, ...notes].join("\n");
}

/**
 * Close any ancestor epic whose children have all closed, walking upwards.
 * Mirrors the existing next_id auto-promote: finishing work should move the
 * board without a second round-trip.
 */
export async function closeCompletedParents(session: TrackerSession, fromStoryId: number): Promise<Story[]> {
	const db = session.db;
	const closed: Story[] = [];
	const seen = new Set<number>();
	let cursor = getStoryById(db, fromStoryId)?.parent_id ?? null;

	while (cursor !== null && !seen.has(cursor)) {
		seen.add(cursor);
		const epic = getStoryById(db, cursor);
		if (!epic || !isOpen(epic)) break;
		const children = getChildren(db, epic.id);
		if (children.length === 0 || children.some(isOpen)) break;

		const updated = await transitionStatus(session, epic.id, {
			status: "done",
			resolution: "completed",
			resolution_note: `All ${children.length} child stories closed.`,
			handoff_notes: rollUpHandoffNotes(epic, children),
		});
		if (!updated) break;
		closed.push(updated);
		cursor = updated.parent_id;
	}
	return closed;
}

/**
 * Advance the `next_id` chain after a story closes, and say what happened.
 *
 * The message is the point: closing a story is where the agent finds out what to
 * pick up, and a next story still waiting on a dependency has to say so or it
 * looks like the chain simply ended.
 */
export async function promoteNextStory(
	session: TrackerSession,
	closed: Story,
): Promise<{ note: string; promoted: Story | null }> {
	const db = session.db;
	if (!closed.next_id) return { note: "", promoted: null };

	const next = getStoryById(db, closed.next_id);
	if (!next || next.status === "done" || next.status === "cancelled") return { note: "", promoted: null };

	const unmet = next.depends_on.filter((id) => getStoryById(db, id)?.status !== "done");
	if (unmet.length > 0) {
		return {
			note: `\n\nNext story #${next.id} (${next.title}) is still waiting on dependencies: ${unmet.map((id) => `#${id}`).join(", ")}`,
			promoted: null,
		};
	}
	if (next.status === "in_progress") return { note: "", promoted: null };

	const promoted = await transitionStatus(session, next.id, { status: "ready" });
	return {
		note: `\n\n>>> NEXT UP: Story #${next.id} is now READY.\nTitle: ${next.title}\nSub-goal: ${next.sub_goal}\nProposed changes: ${next.proposed_changes}`,
		promoted,
	};
}

/**
 * The one story that is ready to be worked on now, or null.
 *
 * `getStoriesByStatus` already returns `ORDER BY priority ASC, id ASC`, so the
 * first survivor of the filter is the highest-priority one — no re-sort. Epics
 * are containers and are never handed out as work.
 *
 * This used to be written twice, once for the `get_next` action and once for the
 * injected context, with different-looking but equivalent tie-breaking. One
 * answer to "what is next" is worth more than two that happen to agree.
 */
export function selectReadyStory(db: DatabaseSync): Story | null {
	return (
		getStoriesByStatus(db, "ready")
			.filter((s) => !hasChildren(db, s.id))
			.find((s) => s.depends_on.every((id) => getStoryById(db, id)?.status === "done")) ?? null
	);
}

/** How many stories are still open — the number on the footer's status line. */
export function openStoryCount(db: DatabaseSync): number {
	return getAllStories(db).filter(isOpen).length;
}
