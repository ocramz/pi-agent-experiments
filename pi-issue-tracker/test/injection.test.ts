import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createStory, setAppState, updateStory } from "../src/database.ts";
import { startEpic } from "../src/epic.ts";
import { buildStoryContext, STORY_CONTEXT_TYPE } from "../src/injection.ts";
import type { Story } from "../src/types.ts";
import { createTempRepo, type TempRepo } from "./helpers/repo.ts";

/**
 * The block injected ahead of every agent turn.
 *
 * This is the extension's biggest prompt and the one that rides on every
 * request, so its caps and its section conditions are load-bearing. It was
 * unreachable from any test while it lived in a `before_agent_start` handler —
 * a live model reading it was the only check that a section appeared at all.
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

const content = (r: TempRepo): string => buildStoryContext(r.session)?.content ?? "";

describe("buildStoryContext", () => {
	it("returns null when there is nothing at all to say", async () => {
		const r = await repo();
		assert.equal(buildStoryContext(r.session), null);
	});

	it("carries the customType the context hook prunes on", async () => {
		const r = await repo();
		makeStory(r, { title: "Something" });
		assert.equal(buildStoryContext(r.session)!.customType, STORY_CONTEXT_TYPE);
		assert.equal(buildStoryContext(r.session)!.display, true);
	});

	/**
	 * A board of nothing but closed stories has nothing to inject: no focus, no
	 * open work, no top-level story. One open story is enough to change that,
	 * even when it is not actionable.
	 */
	it("stays silent for a board of only closed stories, and speaks once one is open", async () => {
		const r = await repo();
		makeStory(r, { title: "Finished", status: "done" });
		assert.equal(buildStoryContext(r.session), null);

		makeStory(r, { title: "Still open", status: "draft" });
		assert.match(content(r), />>> NO ACTIVE WORK/);
	});
});

describe("the focus section", () => {
	it("names the ready story as the thing to work on now", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Hash passwords", sub_goal: "bcrypt", proposed_changes: "add auth.ts" });
		const text = content(r);
		assert.match(text, />>> NEXT UP — work on this now/);
		assert.match(text, new RegExp(`#${story.id}: Hash passwords`));
		assert.match(text, /Sub-goal: bcrypt/);
		assert.match(text, /Changes: add auth\.ts/);
	});

	it("names the parent epic the story belongs to", async () => {
		const r = await repo();
		const epic = makeStory(r, { title: "Add auth", status: "draft" });
		makeStory(r, { title: "Child", parent_id: epic.id });
		assert.match(content(r), new RegExp(`Part of: #${epic.id} Add auth`));
	});

	it("lists the dependencies it cleared, so the agent can see why this one is next", async () => {
		const r = await repo();
		const done = makeStory(r, { title: "Prereq", status: "done" });
		makeStory(r, { title: "Follows", depends_on: [done.id] });
		assert.match(content(r), new RegExp(`Dependencies met: #${done.id}`));
	});

	it("falls back to the in-progress story when nothing is ready", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Half done", status: "in_progress" });
		const text = content(r);
		assert.match(text, />>> IN PROGRESS — continue working on this/);
		assert.match(text, new RegExp(`#${story.id}: Half done`));
		assert.ok(!text.includes(">>> NEXT UP"));
	});

	it("prefers a ready story over one already in progress", async () => {
		const r = await repo();
		makeStory(r, { title: "Underway", status: "in_progress", priority: 0 });
		makeStory(r, { title: "Queued", status: "ready", priority: 1 });
		const text = content(r);
		assert.match(text, />>> NEXT UP/);
		assert.ok(!text.includes(">>> IN PROGRESS —"));
	});

	it("says so plainly when there is open work but none of it is actionable", async () => {
		const r = await repo();
		makeStory(r, { title: "Draft", status: "draft" });
		assert.match(content(r), />>> NO ACTIVE WORK — no ready or in-progress stories/);
	});
});

describe("the big picture and just-completed sections", () => {
	it("shows the top-level story when one is set", async () => {
		const r = await repo();
		const top = makeStory(r, { title: "Ship v2", sub_goal: "the whole release", status: "draft" });
		setAppState(r.db, "top_level_story_id", String(top.id));
		const text = content(r);
		assert.match(text, />>> BIG PICTURE/);
		assert.match(text, new RegExp(`#${top.id}: Ship v2`));
		assert.match(text, /the whole release/);
	});

	/**
	 * "Just completed" means *since the previous turn*, so reading it has to clear
	 * it. Leaving it set would repeat the line on every subsequent turn.
	 */
	it("reports the story closed last turn once, then stops", async () => {
		const r = await repo();
		const closed = makeStory(r, { title: "Done thing", status: "done" });
		makeStory(r, { title: "Open thing" });
		setAppState(r.db, "last_closed_story_id", String(closed.id));

		const first = content(r);
		assert.match(first, />>> JUST COMPLETED \(previous turn\)/);
		assert.match(first, new RegExp(`#${closed.id}: Done thing`));

		assert.ok(!content(r).includes(">>> JUST COMPLETED"));
	});
});

describe("the also-in-progress section", () => {
	const many = async (count: number) => {
		const r = await repo();
		for (let i = 0; i < count; i++) {
			makeStory(r, { title: `Task ${i}`, status: "in_progress", priority: i });
		}
		return r;
	};

	it("lists the other in-progress stories, excluding the one in focus", async () => {
		const r = await many(3);
		const text = content(r);
		assert.match(text, />>> ALSO IN PROGRESS/);
		assert.ok(!text.includes("▶ #1:"), "the primary focus was repeated in the list");
		assert.match(text, /▶ #2: Task 1/);
		assert.match(text, /▶ #3: Task 2/);
	});

	/** This rides on every turn, so the list has to have an end. */
	it("caps the list at five and says how many it did not name", async () => {
		const r = await many(9);
		const text = content(r);
		assert.equal(text.match(/  ▶ #/g)?.length, 5);
		assert.match(text, /\.\.\. 3 more/);
	});

	it("omits the section entirely when only one story is in progress", async () => {
		const r = await many(1);
		assert.ok(!content(r).includes(">>> ALSO IN PROGRESS"));
	});

	it("truncates a long sub-goal rather than pasting it whole", async () => {
		const r = await repo();
		makeStory(r, { title: "Focus", status: "in_progress", priority: 0 });
		makeStory(r, { title: "Other", status: "in_progress", priority: 1, sub_goal: "x".repeat(100) });
		const text = content(r);
		assert.match(text, /▶ #2: Other — x{60}…/);
	});
});

describe("the memory sections", () => {
	it("surfaces a learning from related closed work, truncated", async () => {
		const r = await repo();
		makeStory(r, { title: "password hashing", sub_goal: "hash the password" });
		const past = makeStory(r, { title: "password storage", sub_goal: "store the password", status: "done" });
		updateStory(r.db, past.id, { learnings: "l".repeat(300) });

		const text = content(r);
		assert.match(text, />>> LESSONS FROM COMPLETED WORK/);
		assert.match(text, new RegExp(`⚠ #${past.id} password storage: l{200}…`));
	});

	it("surfaces a handoff note from related work, truncated further", async () => {
		const r = await repo();
		makeStory(r, { title: "password hashing", sub_goal: "hash the password" });
		const past = makeStory(r, { title: "password storage", sub_goal: "store the password", status: "done" });
		updateStory(r.db, past.id, { handoff_notes: "h".repeat(400) });

		const text = content(r);
		assert.match(text, />>> HANDOFF NOTES FROM RELATED WORK/);
		assert.match(text, new RegExp(`↪ #${past.id} password storage: h{300}…`));
	});

	it("shows related open stories", async () => {
		const r = await repo();
		makeStory(r, { title: "password hashing", sub_goal: "hash the password" });
		const sibling = makeStory(r, { title: "password reset", sub_goal: "reset the password", status: "draft" });
		assert.match(content(r), new RegExp(`◇ #${sibling.id}: password reset`));
	});

	it("omits all three sections when nothing is in focus", async () => {
		const r = await repo();
		makeStory(r, { title: "Draft only", status: "draft" });
		const text = content(r);
		assert.ok(!text.includes(">>> RELATED STORIES"));
		assert.ok(!text.includes(">>> LESSONS FROM COMPLETED WORK"));
		assert.ok(!text.includes(">>> HANDOFF NOTES FROM RELATED WORK"));
	});
});

describe("the review nudges", () => {
	/** The gates are enforced, so an unreviewed story stalls silently without this. */
	it("tells the agent to review the plan before starting a ready story", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Unreviewed" });
		assert.match(
			content(r),
			new RegExp(`>>> BEFORE STARTING — #${story.id} needs a plan review: story\\{action:"review_plan", story_id:${story.id}\\}`),
		);
	});

	it("says nothing once the plan review is approved", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Reviewed" });
		updateStory(r.db, story.id, { review: { plan: { verdict: "approved", by: "self", at: 1, findings: "" } } });
		assert.ok(!content(r).includes(">>> BEFORE STARTING"));
	});

	it("tells the agent to review the work before closing an in-progress story", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Underway", status: "in_progress" });
		assert.match(
			content(r),
			new RegExp(`>>> BEFORE CLOSING — #${story.id} needs a work review: story\\{action:"review_work", story_id:${story.id}\\}`),
		);
	});

	it("nudges about starting rather than closing when both could apply", async () => {
		const r = await repo();
		makeStory(r, { title: "Underway", status: "in_progress", priority: 0 });
		makeStory(r, { title: "Queued", status: "ready", priority: 1 });
		const text = content(r);
		assert.match(text, />>> BEFORE STARTING/);
		assert.ok(!text.includes(">>> BEFORE CLOSING"));
	});
});

describe("the epic branch section", () => {
	it("says nothing when the session is not in an epic", async () => {
		const r = await repo();
		makeStory(r, { title: "Loose" });
		assert.ok(!content(r).includes(">>> EPIC BRANCH"));
	});

	it("names the branch and its base, and forbids hand commits", async () => {
		const r = await repo();
		const epicStory = makeStory(r, { title: "Add auth", status: "draft" });
		makeStory(r, { title: "Child", parent_id: epicStory.id });
		const started = await startEpic(r.session, { story: epicStory });
		assert.ok(started.ok && started.epic, started.note);
		r.session.epicId = started.epic.epic_id;

		const text = content(r);
		assert.match(text, />>> EPIC BRANCH/);
		assert.match(text, new RegExp(`Working on ${started.epic.branch} \\(started from feat/test\\)`));
		assert.match(text, /do not commit by hand/);
		assert.match(text, /Do not switch branches, reset --hard, or delete branches/);
		// Branch mode is not a worktree, so it must not claim a dedicated directory.
		assert.ok(!text.includes("dedicated worktree"));
	});

	it("drops the section once the epic is no longer active", async () => {
		const r = await repo();
		const epicStory = makeStory(r, { title: "Add auth", status: "draft" });
		makeStory(r, { title: "Child", parent_id: epicStory.id });
		const started = await startEpic(r.session, { story: epicStory });
		assert.ok(started.ok && started.epic);
		r.session.epicId = started.epic.epic_id;
		assert.match(content(r), />>> EPIC BRANCH/);

		// Another session ends it; this one is not told, and must notice anyway.
		r.db.prepare("UPDATE epic_branches SET state = 'merged' WHERE epic_id = ?").run(started.epic.epic_id);
		assert.ok(!content(r).includes(">>> EPIC BRANCH"));
	});
});
