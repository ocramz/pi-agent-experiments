import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { type ActionResult, runStoryAction, type StoryActionParams } from "../src/actions.ts";
import { createStory, getAppState, getStoryById, updateStory } from "../src/database.ts";
import { startEpic } from "../src/epic.ts";
import type { Story } from "../src/types.ts";
import { createTempRepo, stubVerdict, type TempRepo } from "./helpers/repo.ts";

/**
 * All thirteen actions behind the `story` tool.
 *
 * Until these moved out of `extensions/index.ts` the only thing that ever
 * exercised them was a live model in `test/container/test_extension_live.sh` —
 * which costs money, is not deterministic, and reaches a branch only if the
 * model happens to choose it. The refusals are the ones that most needed this:
 * every gate below is a path a model is *supposed* not to take.
 */

const repos: TempRepo[] = [];
async function repo(): Promise<TempRepo> {
	const created = await createTempRepo();
	repos.push(created);
	return created;
}
after(() => {
	for (const created of repos) created.cleanup();
});

function makeStory(r: TempRepo, fields: Partial<Story> & { title: string }): Story {
	return createStory(r.db, {
		title: fields.title,
		sub_goal: fields.sub_goal ?? "do the thing",
		proposed_changes: fields.proposed_changes ?? "change the code",
		status: fields.status ?? "ready",
		priority: fields.priority ?? 0,
		parent_id: fields.parent_id ?? null,
		next_id: fields.next_id ?? null,
		depends_on: fields.depends_on ?? [],
	});
}

const APPROVED = { verdict: "approved" as const, by: "self", at: 1, findings: "" };

/** Run an action with no reviewer configured — the self-review path. */
function run(r: TempRepo, params: StoryActionParams, reviewer = null): Promise<ActionResult> {
	return runStoryAction(r.session, params, { reviewer });
}

const errorOf = (result: ActionResult): unknown => result.details.error;

describe("create", () => {
	it("creates a draft story and shows it back in full", async () => {
		const r = await repo();
		const result = await run(r, { action: "create", title: "Add auth", sub_goal: "sign in" });
		const story = result.details.story as Story;
		assert.equal(story.status, "draft");
		assert.match(result.text, /Created story #\d+: Add auth/);
		assert.match(result.text, /Sub-goal: sign in/);
		assert.equal(result.refreshStatus, true);
	});

	it("requires both a title and a sub-goal", async () => {
		const r = await repo();
		assert.equal(errorOf(await run(r, { action: "create", title: "Only a title" })), "missing fields");
		assert.equal(errorOf(await run(r, { action: "create", sub_goal: "only a goal" })), "missing fields");
	});

	/** A parent that does not exist would produce a row nothing can reach. */
	it("refuses a parent that does not exist", async () => {
		const r = await repo();
		const result = await run(r, { action: "create", title: "T", sub_goal: "G", parent_story_id: 999 });
		assert.equal(errorOf(result), "parent not found");
	});

	it("appends to the end of the board rather than restarting the ordering", async () => {
		const r = await repo();
		makeStory(r, { title: "Existing", priority: 7 });
		const result = await run(r, { action: "create", title: "New", sub_goal: "G" });
		assert.equal((result.details.story as Story).priority, 8);
	});
});

describe("update", () => {
	it("edits the fields it was given and leaves the rest alone", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Old", sub_goal: "unchanged" });
		const result = await run(r, { action: "update", story_id: story.id, title: "New" });
		assert.equal((result.details.story as Story).title, "New");
		assert.equal((result.details.story as Story).sub_goal, "unchanged");
	});

	it("requires a story_id", async () => {
		const r = await repo();
		assert.equal(errorOf(await run(r, { action: "update", title: "T" })), "missing story_id");
	});

	it("reports a story that does not exist", async () => {
		const r = await repo();
		assert.equal(errorOf(await run(r, { action: "update", story_id: 999, title: "T" })), "not found");
	});

	/**
	 * The bug this closes was observed in a live run: refused by
	 * `mark_in_progress`, the model set the status here instead and carried on.
	 * Without the redirect the review gates are decorative.
	 */
	it("refuses to set in_progress, and names the action that runs the checks", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "T" });
		const result = await run(r, { action: "update", story_id: story.id, status: "in_progress" });
		assert.equal(errorOf(result), "status in_progress requires mark_in_progress");
		assert.match(result.text, /use mark_in_progress instead/);
		assert.equal(getStoryById(r.db, story.id)!.status, "ready");
	});

	it("refuses to set done, and mentions the extra fields mark_done requires", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "T" });
		const result = await run(r, { action: "update", story_id: story.id, status: "done" });
		assert.equal(errorOf(result), "status done requires mark_done");
		assert.match(result.text, /resolution and handoff notes/);
	});

	/** Abandoning a story is not the same act as declaring it finished. */
	it("still allows cancelling — the only route to it from the tool", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "T" });
		await run(r, { action: "update", story_id: story.id, status: "cancelled" });
		assert.equal(getStoryById(r.db, story.id)!.status, "cancelled");
	});

	it("allows the ungated bookkeeping statuses", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "T" });
		for (const status of ["draft", "ready", "archived"] as const) {
			await run(r, { action: "update", story_id: story.id, status });
			assert.equal(getStoryById(r.db, story.id)!.status, status);
		}
	});

	it("refuses to make a story its own parent", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "T" });
		assert.equal(
			errorOf(await run(r, { action: "update", story_id: story.id, parent_story_id: story.id })),
			"self parent",
		);
	});

	it("refuses a reparent that would close a cycle", async () => {
		const r = await repo();
		const parent = makeStory(r, { title: "Parent" });
		const child = makeStory(r, { title: "Child", parent_id: parent.id });
		assert.equal(
			errorOf(await run(r, { action: "update", story_id: parent.id, parent_story_id: child.id })),
			"cycle",
		);
	});

	it("refuses a parent that does not exist", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "T" });
		assert.equal(
			errorOf(await run(r, { action: "update", story_id: story.id, parent_story_id: 999 })),
			"parent not found",
		);
	});

	/** null means detach, which is why the parent check tests for a number. */
	it("detaches from a parent when passed null", async () => {
		const r = await repo();
		const parent = makeStory(r, { title: "Parent" });
		const child = makeStory(r, { title: "Child", parent_id: parent.id });
		await run(r, { action: "update", story_id: child.id, parent_story_id: null });
		assert.equal(getStoryById(r.db, child.id)!.parent_id, null);
	});
});

describe("delete", () => {
	it("deletes the story and says so", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Doomed" });
		const result = await run(r, { action: "delete", story_id: story.id });
		assert.match(result.text, /Deleted story #\d+: Doomed/);
		assert.equal(getStoryById(r.db, story.id), null);
	});

	/** There are no foreign keys, so a deleted parent would strand its children. */
	it("reparents the children onto the deleted story's own parent", async () => {
		const r = await repo();
		const grandparent = makeStory(r, { title: "Grandparent" });
		const parent = makeStory(r, { title: "Parent", parent_id: grandparent.id });
		const child = makeStory(r, { title: "Child", parent_id: parent.id });

		const result = await run(r, { action: "delete", story_id: parent.id });
		assert.equal(getStoryById(r.db, child.id)!.parent_id, grandparent.id);
		assert.equal(result.details.reparented, 1);
		assert.match(result.text, new RegExp(`Reparented 1 child story\\(ies\\) to #${grandparent.id}`));
	});

	it("lifts children to the top level when the deleted story had no parent", async () => {
		const r = await repo();
		const parent = makeStory(r, { title: "Parent" });
		const child = makeStory(r, { title: "Child", parent_id: parent.id });

		const result = await run(r, { action: "delete", story_id: parent.id });
		assert.equal(getStoryById(r.db, child.id)!.parent_id, null);
		assert.match(result.text, /to top level/);
	});

	it("reports a story that does not exist", async () => {
		const r = await repo();
		assert.equal(errorOf(await run(r, { action: "delete", story_id: 999 })), "not found");
	});
});

describe("mark_in_progress", () => {
	const ready = (r: TempRepo) => {
		const story = makeStory(r, { title: "Work" });
		updateStory(r.db, story.id, { review: { plan: APPROVED } });
		return getStoryById(r.db, story.id)!;
	};

	it("starts a reviewed story", async () => {
		const r = await repo();
		const story = ready(r);
		const result = await run(r, { action: "mark_in_progress", story_id: story.id });
		assert.match(result.text, /is now IN PROGRESS/);
		assert.equal(getStoryById(r.db, story.id)!.status, "in_progress");
	});

	it("refuses an epic and points at its children", async () => {
		const r = await repo();
		const epic = ready(r);
		makeStory(r, { title: "Child", parent_id: epic.id });
		const result = await run(r, { action: "mark_in_progress", story_id: epic.id });
		assert.equal(errorOf(result), "is an epic");
	});

	it("refuses while a dependency is open", async () => {
		const r = await repo();
		const blocker = makeStory(r, { title: "Blocker", status: "in_progress" });
		const story = makeStory(r, { title: "Blocked", depends_on: [blocker.id] });
		updateStory(r.db, story.id, { review: { plan: APPROVED } });
		const result = await run(r, { action: "mark_in_progress", story_id: story.id });
		assert.equal(errorOf(result), "unmet dependencies");
		assert.deepEqual(result.details.unmet, [blocker.id]);
	});

	it("refuses an unreviewed plan", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Unreviewed" });
		const result = await run(r, { action: "mark_in_progress", story_id: story.id });
		assert.equal(errorOf(result), "plan not approved");
		assert.equal(getStoryById(r.db, story.id)!.status, "ready");
	});

	it("requires a story_id and reports a missing story", async () => {
		const r = await repo();
		assert.equal(errorOf(await run(r, { action: "mark_in_progress" })), "missing story_id");
		assert.equal(errorOf(await run(r, { action: "mark_in_progress", story_id: 999 })), "not found");
	});
});

describe("mark_done", () => {
	const closable = (r: TempRepo, extra: Partial<Story> = {}) => {
		const story = makeStory(r, { title: "Work", status: "in_progress", ...extra });
		updateStory(r.db, story.id, { review: { plan: APPROVED, work: APPROVED } });
		return getStoryById(r.db, story.id)!;
	};
	const done = { action: "mark_done" as const, resolution: "completed" as const, handoff_notes: "it lives in auth.ts" };

	it("closes a reviewed story with a resolution and a handoff note", async () => {
		const r = await repo();
		const story = closable(r);
		const result = await run(r, { ...done, story_id: story.id });
		assert.match(result.text, /marked as DONE \(completed\)/);
		const closed = getStoryById(r.db, story.id)!;
		assert.equal(closed.status, "done");
		assert.equal(closed.handoff_notes, "it lives in auth.ts");
	});

	it("records the closed story so the next turn's context can mention it", async () => {
		const r = await repo();
		const story = closable(r);
		await run(r, { ...done, story_id: story.id });
		assert.equal(getAppState(r.db, "last_closed_story_id"), String(story.id));
	});

	it("refuses without a resolution", async () => {
		const r = await repo();
		const story = closable(r);
		const result = await run(r, { action: "mark_done", story_id: story.id, handoff_notes: "note" });
		assert.equal(errorOf(result), "resolution required");
		assert.equal(getStoryById(r.db, story.id)!.status, "in_progress");
	});

	it("refuses without a handoff note", async () => {
		const r = await repo();
		const story = closable(r);
		const result = await run(r, { action: "mark_done", story_id: story.id, resolution: "completed" });
		assert.equal(errorOf(result), "handoff_notes required");
	});

	it("refuses unreviewed work", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Unreviewed", status: "in_progress" });
		assert.equal(errorOf(await run(r, { ...done, story_id: story.id })), "work not approved");
	});

	it("refuses while a dependency is open", async () => {
		const r = await repo();
		const blocker = makeStory(r, { title: "Blocker", status: "in_progress" });
		const story = closable(r, { depends_on: [blocker.id] });
		assert.equal(errorOf(await run(r, { ...done, story_id: story.id })), "unmet dependencies");
	});

	it("refuses an epic that still has open children, and says they will close it", async () => {
		const r = await repo();
		const epic = makeStory(r, { title: "Epic", status: "in_progress" });
		makeStory(r, { title: "Child", parent_id: epic.id });
		const result = await run(r, { ...done, story_id: epic.id });
		assert.equal(errorOf(result), "open children");
		assert.match(result.text, /They close it automatically/);
	});

	it("promotes the next story and describes it in the same response", async () => {
		const r = await repo();
		const next = makeStory(r, { title: "Second", status: "draft" });
		const story = closable(r, { next_id: next.id });
		const result = await run(r, { ...done, story_id: story.id });
		assert.match(result.text, />>> NEXT UP: Story #\d+ is now READY/);
		assert.equal(getStoryById(r.db, next.id)!.status, "ready");
	});

	it("closes the parent epic when the last child closes, and says so", async () => {
		const r = await repo();
		const epic = makeStory(r, { title: "Epic", status: "in_progress" });
		const child = closable(r, { parent_id: epic.id });
		const result = await run(r, { ...done, story_id: child.id });
		assert.match(result.text, />>> EPIC COMPLETE: #\d+ Epic/);
		assert.equal(getStoryById(r.db, epic.id)!.status, "done");
	});

	it("trims the handoff note", async () => {
		const r = await repo();
		const story = closable(r);
		await run(r, { ...done, story_id: story.id, handoff_notes: "  spaced  " });
		assert.equal(getStoryById(r.db, story.id)!.handoff_notes, "spaced");
	});
});

describe("review_plan and review_work", () => {
	it("reports the findings without recording anything when no verdict is given", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Add auth" });
		const result = await run(r, { action: "review_plan", story_id: story.id });
		assert.equal(result.details.recorded, false);
		assert.equal(getStoryById(r.db, story.id)!.review.plan, undefined);
		assert.equal(result.reviewed, true);
	});

	it("records a self-verdict and says what it unlocks", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Add auth" });
		const result = await run(r, {
			action: "review_plan",
			story_id: story.id,
			verdict: "approved",
			findings: "the plan is fine",
		});
		assert.equal(result.details.recorded, true);
		assert.equal(getStoryById(r.db, story.id)!.review.plan?.verdict, "approved");
		assert.match(result.text, /you may now mark_in_progress on #\d+/);
	});

	it("points at mark_done after an approved work review", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Add auth", status: "in_progress" });
		const result = await run(r, {
			action: "review_work",
			story_id: story.id,
			verdict: "approved",
			findings: "looks done",
		});
		assert.match(result.text, /you may now mark_done on #\d+ with a resolution and handoff_notes/);
	});

	/**
	 * You do not grade your own work when someone else was asked to. The call is
	 * refused rather than silently overridden, so the agent finds out that its
	 * verdict was never the deciding one.
	 */
	it("refuses the agent's own verdict outright when a reviewer is configured", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Add auth" });
		const reviewer = stubVerdict("changes_requested", "split this up");
		const result = await runStoryAction(
			r.session,
			{ action: "review_plan", story_id: story.id, verdict: "approved", findings: "fine by me" },
			{ reviewer },
		);
		assert.equal(result.details.recorded, false);
		assert.equal(getStoryById(r.db, story.id)!.review.plan, undefined);
		assert.match(result.text, /not yours to set/);
		assert.equal(reviewer.calls.length, 0, "a malformed call must not spend a reviewer turn");
	});

	it("records the configured reviewer's verdict when the agent asks without one", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Add auth" });
		const reviewer = stubVerdict("changes_requested", "split this up");
		const result = await runStoryAction(r.session, { action: "review_plan", story_id: story.id }, { reviewer });

		assert.equal(result.details.recorded, true);
		assert.equal(getStoryById(r.db, story.id)!.review.plan?.verdict, "changes_requested");
		assert.match(result.text, /CHANGES_REQUESTED \(by stub\/reviewer-1\)/);
	});

	it("records changes_requested with the instruction to review again", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Add auth" });
		const result = await run(r, {
			action: "review_plan",
			story_id: story.id,
			verdict: "changes_requested",
			findings: "too big",
		});
		assert.match(result.text, /Changes requested — address them and review again\./);
	});

	it("requires a story_id and reports a missing story", async () => {
		const r = await repo();
		assert.equal(errorOf(await run(r, { action: "review_plan" })), "missing story_id");
		assert.equal(errorOf(await run(r, { action: "review_work", story_id: 999 })), "not found");
	});
});

describe("list, search and get_next", () => {
	it("lists every story in full when no filter is given", async () => {
		const r = await repo();
		makeStory(r, { title: "One" });
		makeStory(r, { title: "Two", status: "done" });
		const result = await run(r, { action: "list" });
		assert.equal((result.details.stories as Story[]).length, 2);
		assert.match(result.text, /Sub-goal:/);
	});

	it("filters by status", async () => {
		const r = await repo();
		makeStory(r, { title: "Open" });
		makeStory(r, { title: "Closed", status: "done" });
		const result = await run(r, { action: "list", status_filter: "done" });
		assert.deepEqual((result.details.stories as Story[]).map((s) => s.title), ["Closed"]);
	});

	/** A typo that returned nothing would read as an empty board. */
	it("ignores an unrecognised filter rather than reporting an empty board", async () => {
		const r = await repo();
		makeStory(r, { title: "One" });
		const result = await run(r, { action: "list", status_filter: "not-a-status" });
		assert.equal((result.details.stories as Story[]).length, 1);
	});

	it("says so plainly when there is nothing to list", async () => {
		const r = await repo();
		assert.equal((await run(r, { action: "list" })).text, "No stories found.");
	});

	it("searches, and says so when nothing matches", async () => {
		const r = await repo();
		makeStory(r, { title: "Add authentication" });
		assert.match((await run(r, { action: "search", query: "authentication" })).text, /Add authentication/);
		assert.equal((await run(r, { action: "search", query: "zzzz" })).text, "No matches.");
		assert.equal(errorOf(await run(r, { action: "search" })), "missing query");
	});

	it("hands out the top ready story, or says there is none", async () => {
		const r = await repo();
		assert.match((await run(r, { action: "get_next" })).text, /No ready stories available right now\./);
		const story = makeStory(r, { title: "Next thing" });
		const result = await run(r, { action: "get_next" });
		assert.equal((result.details.story as Story).id, story.id);
		assert.match(result.text, /Next story to work on:/);
	});
});

describe("set_top_level", () => {
	it("records the story the big-picture block will show", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Ship v2" });
		const result = await run(r, { action: "set_top_level", story_id: story.id });
		assert.equal(getAppState(r.db, "top_level_story_id"), String(story.id));
		assert.match(result.text, /Top-level story set to #\d+: Ship v2/);
	});

	it("reports a story that does not exist", async () => {
		const r = await repo();
		assert.equal(errorOf(await run(r, { action: "set_top_level", story_id: 999 })), "not found");
	});
});

describe("reorder", () => {
	it("assigns priority in the order given and chains next_id along it", async () => {
		const r = await repo();
		const a = makeStory(r, { title: "A" });
		const b = makeStory(r, { title: "B" });
		const c = makeStory(r, { title: "C" });

		await run(r, { action: "reorder", ordered_ids: [c.id, a.id, b.id] });
		assert.equal(getStoryById(r.db, c.id)!.priority, 0);
		assert.equal(getStoryById(r.db, a.id)!.priority, 1);
		assert.equal(getStoryById(r.db, c.id)!.next_id, a.id);
		assert.equal(getStoryById(r.db, b.id)!.next_id, null);
	});

	/** Half a reorder would leave the chain pointing at rows nobody named. */
	it("validates every id before writing anything", async () => {
		const r = await repo();
		const a = makeStory(r, { title: "A", priority: 5 });
		const result = await run(r, { action: "reorder", ordered_ids: [a.id, 999] });
		assert.equal(errorOf(result), "not found");
		assert.equal(getStoryById(r.db, a.id)!.priority, 5);
	});

	it("requires a non-empty list", async () => {
		const r = await repo();
		assert.equal(errorOf(await run(r, { action: "reorder" })), "missing ordered_ids");
		assert.equal(errorOf(await run(r, { action: "reorder", ordered_ids: [] })), "missing ordered_ids");
	});
});

describe("simplify", () => {
	it("merges the sources into one story and archives them as superseded", async () => {
		const r = await repo();
		const a = makeStory(r, { title: "A", sub_goal: "goal a", proposed_changes: "change a" });
		const b = makeStory(r, { title: "B", sub_goal: "goal b", proposed_changes: "change b" });

		const result = await run(r, { action: "simplify", source_ids: [a.id, b.id], merged_title: "AB" });
		const merged = result.details.merged as Story;
		assert.equal(merged.title, "AB");
		assert.equal(merged.sub_goal, "goal a\ngoal b");
		assert.equal(merged.proposed_changes, "change a\n---\nchange b");
		for (const source of [a, b]) {
			const archived = getStoryById(r.db, source.id)!;
			assert.equal(archived.status, "archived");
			assert.equal(archived.resolution, "superseded");
			assert.equal(archived.resolution_note, `Merged into #${merged.id}`);
		}
	});

	it("builds a title from the sources when none is given", async () => {
		const r = await repo();
		const a = makeStory(r, { title: "A" });
		const b = makeStory(r, { title: "B" });
		const result = await run(r, { action: "simplify", source_ids: [a.id, b.id] });
		assert.equal((result.details.merged as Story).title, "Merged: A + B");
	});

	it("keeps the epic when every source sat under the same one", async () => {
		const r = await repo();
		const epic = makeStory(r, { title: "Epic" });
		const a = makeStory(r, { title: "A", parent_id: epic.id });
		const b = makeStory(r, { title: "B", parent_id: epic.id });
		const result = await run(r, { action: "simplify", source_ids: [a.id, b.id] });
		assert.equal((result.details.merged as Story).parent_id, epic.id);
	});

	it("goes to the top level when the sources came from different epics", async () => {
		const r = await repo();
		const one = makeStory(r, { title: "Epic one" });
		const two = makeStory(r, { title: "Epic two" });
		const a = makeStory(r, { title: "A", parent_id: one.id });
		const b = makeStory(r, { title: "B", parent_id: two.id });
		const result = await run(r, { action: "simplify", source_ids: [a.id, b.id] });
		assert.equal((result.details.merged as Story).parent_id, null);
	});

	/** A merge that depended on the parts it absorbed could never start. */
	it("drops dependencies on the sources themselves but keeps outside ones", async () => {
		const r = await repo();
		const outside = makeStory(r, { title: "Outside" });
		const a = makeStory(r, { title: "A", depends_on: [outside.id] });
		const b = makeStory(r, { title: "B", depends_on: [a.id] });
		const result = await run(r, { action: "simplify", source_ids: [a.id, b.id] });
		assert.deepEqual((result.details.merged as Story).depends_on, [outside.id]);
	});

	/** Archived never becomes done, so an unrepointed dependent blocks forever. */
	it("repoints anyone depending on a source onto the merged story", async () => {
		const r = await repo();
		const a = makeStory(r, { title: "A" });
		const b = makeStory(r, { title: "B" });
		const dependent = makeStory(r, { title: "Dependent", depends_on: [a.id, b.id] });

		const result = await run(r, { action: "simplify", source_ids: [a.id, b.id] });
		const merged = result.details.merged as Story;
		assert.deepEqual(getStoryById(r.db, dependent.id)!.depends_on, [merged.id]);
	});

	it("adopts the sources' children so they are not stranded on archived rows", async () => {
		const r = await repo();
		const a = makeStory(r, { title: "A" });
		const child = makeStory(r, { title: "Child", parent_id: a.id });
		const b = makeStory(r, { title: "B" });

		const result = await run(r, { action: "simplify", source_ids: [a.id, b.id] });
		assert.equal(getStoryById(r.db, child.id)!.parent_id, (result.details.merged as Story).id);
	});

	it("carries the first source's status forward, collapsing the rest to ready", async () => {
		const r = await repo();
		const a = makeStory(r, { title: "A", status: "in_progress" });
		const b = makeStory(r, { title: "B" });
		assert.equal(
			((await run(r, { action: "simplify", source_ids: [a.id, b.id] })).details.merged as Story).status,
			"in_progress",
		);

		const c = makeStory(r, { title: "C", status: "draft" });
		const d = makeStory(r, { title: "D" });
		assert.equal(
			((await run(r, { action: "simplify", source_ids: [c.id, d.id] })).details.merged as Story).status,
			"ready",
		);
	});

	it("requires at least two sources, and two that exist", async () => {
		const r = await repo();
		const a = makeStory(r, { title: "A" });
		assert.equal(errorOf(await run(r, { action: "simplify", source_ids: [a.id] })), "not enough sources");
		assert.equal(errorOf(await run(r, { action: "simplify" })), "not enough sources");
		assert.equal(errorOf(await run(r, { action: "simplify", source_ids: [a.id, 999] })), "missing sources");
	});
});

describe("dispatch", () => {
	it("reports an action it does not have", async () => {
		const r = await repo();
		const result = await run(r, { action: "teleport" });
		assert.equal(errorOf(result), "unknown");
		assert.match(result.text, /Unknown action: teleport/);
	});

	/**
	 * Git integration is opt-in, so a session with no started epic must behave
	 * exactly as it did before any of it existed — including through the actions
	 * that write status.
	 */
	it("runs the whole close cycle with no epic and no git effect", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Solo" });
		await run(r, { action: "review_plan", story_id: story.id, verdict: "approved", findings: "ok" });
		await run(r, { action: "mark_in_progress", story_id: story.id });
		await run(r, { action: "review_work", story_id: story.id, verdict: "approved", findings: "ok" });
		const result = await run(r, {
			action: "mark_done",
			story_id: story.id,
			resolution: "completed",
			handoff_notes: "nothing to hand off",
		});
		assert.equal(getStoryById(r.db, story.id)!.status, "done");
		assert.ok(!result.text.includes("Committed"), "a story outside an epic must not produce a commit note");
	});

	it("commits the work when the story is inside a started epic", async () => {
		const r = await repo();
		const epicStory = makeStory(r, { title: "Add auth" });
		const child = makeStory(r, { title: "Hash passwords", parent_id: epicStory.id });
		const started = await startEpic(r.session, { story: epicStory });
		assert.ok(started.ok && started.epic, started.note);
		r.session.epicId = started.epic.epic_id;

		await run(r, { action: "review_plan", story_id: child.id, verdict: "approved", findings: "ok" });
		await run(r, { action: "mark_in_progress", story_id: child.id });
		r.write("auth.ts", "export const hash = () => {};\n");
		await run(r, { action: "review_work", story_id: child.id, verdict: "approved", findings: "ok" });
		const result = await run(r, {
			action: "mark_done",
			story_id: child.id,
			resolution: "completed",
			handoff_notes: "hashing lives in auth.ts",
		});
		assert.match(result.text, /marked as DONE/);
		assert.match(result.text, /auth\.ts|Committed|commit/i);
	});
});
