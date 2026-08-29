import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createStory, getStoryById, getStoryCommit, updateStory } from "../src/database.ts";
import { startEpic } from "../src/epic.ts";
import { takeGitNotes } from "../src/session.ts";
import {
	applyTransitionEffects,
	closeCompletedParents,
	openStoryCount,
	promoteNextStory,
	rollUpHandoffNotes,
	selectReadyStory,
	transitionStatus,
} from "../src/transitions.ts";
import type { Story } from "../src/types.ts";
import { createTempRepo, type TempRepo } from "./helpers/repo.ts";

/**
 * The single write path for `status`, and the git effects hanging off it.
 *
 * Untested until it moved out of `extensions/index.ts`. This is the code that
 * decides whether a story's work gets committed at all, so every branch below
 * was previously covered only by a live model happening to close a story inside
 * a started epic.
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
		proposed_changes: fields.proposed_changes ?? "",
		status: fields.status ?? "ready",
		priority: fields.priority ?? 0,
		parent_id: fields.parent_id ?? null,
		next_id: fields.next_id ?? null,
		depends_on: fields.depends_on ?? [],
	});
}

/** An epic with two children, started in branch mode, on the session. */
async function startedEpic(r: TempRepo) {
	const epicStory = makeStory(r, { title: "Add auth" });
	const first = makeStory(r, { title: "Hash passwords", parent_id: epicStory.id });
	const second = makeStory(r, { title: "Session cookies", parent_id: epicStory.id });
	const started = await startEpic(r.session, { story: epicStory });
	assert.ok(started.ok && started.epic, started.note);
	r.session.epicId = started.epic.epic_id;
	return { epicStory, first, second, epic: started.epic };
}

describe("transitionStatus", () => {
	it("writes the status and returns the updated row", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Solo", status: "draft" });
		const updated = await transitionStatus(r.session, story.id, { status: "ready" });
		assert.equal(updated?.status, "ready");
		assert.equal(getStoryById(r.db, story.id)!.status, "ready");
	});

	it("returns null for a story that does not exist", async () => {
		const r = await repo();
		assert.equal(await transitionStatus(r.session, 9999, { status: "ready" }), null);
	});

	/**
	 * Git integration is opt-in. Until `/start-epic` runs, a status change must
	 * behave exactly as it did before any of this existed.
	 */
	it("has no git effect at all for a story outside any epic", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Unmanaged" });
		await transitionStatus(r.session, story.id, { status: "in_progress" });
		assert.equal(getStoryCommit(r.db, story.id), null);
		assert.equal(takeGitNotes(r.session), "");
	});

	/**
	 * The status write has already succeeded by the time git runs. Losing it
	 * because a subprocess failed would leave the board disagreeing with itself.
	 */
	it("keeps the status change when the git side effect throws, and says so in a note", async () => {
		const r = await repo();
		const { first } = await startedEpic(r);
		// A runner that throws rather than reporting a non-zero exit — the one
		// shape `GitRunner`'s never-throw contract does not cover.
		r.session.git = (async () => {
			throw new Error("git exploded");
		}) as typeof r.session.git;

		const updated = await transitionStatus(r.session, first.id, { status: "in_progress" });
		assert.equal(updated?.status, "in_progress");
		assert.equal(getStoryById(r.db, first.id)!.status, "in_progress");
		assert.match(takeGitNotes(r.session), /git side effect failed: git exploded/);
	});
});

describe("applyTransitionEffects", () => {
	it("records where work began, so it can be undone later", async () => {
		const r = await repo();
		const { first } = await startedEpic(r);
		await transitionStatus(r.session, first.id, { status: "in_progress" });
		const record = getStoryCommit(r.db, first.id);
		assert.ok(record?.start_commit, "no start commit recorded");
	});

	it("records the start only on the transition into in_progress, not on every write", async () => {
		const r = await repo();
		const { first } = await startedEpic(r);
		await transitionStatus(r.session, first.id, { status: "in_progress" });
		const firstSha = getStoryCommit(r.db, first.id)!.start_commit;

		r.write("unrelated.txt", "someone else's work\n");
		await r.commit("someone else's commit");
		await transitionStatus(r.session, first.id, { status: "in_progress", title: "Renamed" });
		assert.equal(getStoryCommit(r.db, first.id)!.start_commit, firstSha);
	});

	it("commits what a closed story changed", async () => {
		const r = await repo();
		const { first } = await startedEpic(r);
		await transitionStatus(r.session, first.id, { status: "in_progress" });
		r.write("auth.ts", "export const hash = () => {};\n");

		await transitionStatus(r.session, first.id, { status: "done", resolution: "completed" });
		assert.ok(getStoryCommit(r.db, first.id)?.commit_sha, "no commit recorded for the closed story");
	});

	/** Epics are containers. A commit of their own would duplicate their children's. */
	it("does not commit for an epic — that is what its children are for", async () => {
		const r = await repo();
		const { epicStory, first, second } = await startedEpic(r);
		await transitionStatus(r.session, first.id, { status: "done", resolution: "completed" });
		await transitionStatus(r.session, second.id, { status: "done", resolution: "completed" });
		takeGitNotes(r.session);

		await transitionStatus(r.session, epicStory.id, { status: "done", resolution: "completed" });
		assert.equal(getStoryCommit(r.db, epicStory.id)?.commit_sha ?? null, null);
	});

	/**
	 * Bringing the base branch in happens while the agent is still present to
	 * resolve conflicts. The merge *into* the base is a separate, user-confirmed
	 * step and never fires here.
	 */
	it("updates the epic branch from its base when the epic closes, and says it is ready to merge", async () => {
		const r = await repo();
		const { epicStory } = await startedEpic(r);
		await transitionStatus(r.session, epicStory.id, { status: "done", resolution: "completed" });
		assert.match(takeGitNotes(r.session), /ready to merge — run \/merge-epic/);
	});

	it("hands merge conflicts to the agent rather than burying them in a note", async () => {
		const r = await repo();
		const { epicStory, first } = await startedEpic(r);

		// Diverge: the same file changed on the base branch and on the epic.
		await transitionStatus(r.session, first.id, { status: "in_progress" });
		r.write("contested.txt", "epic side\n");
		await r.commit("epic edit");

		const epicId = r.session.epicId!;
		await r.git(["switch", "--quiet", "feat/test"]);
		r.write("contested.txt", "base side\n");
		await r.commit("base edit");
		await r.git(["switch", "--quiet", `epic/${epicId}-add-auth`]);

		await transitionStatus(r.session, epicStory.id, { status: "done", resolution: "completed" });
		assert.equal(r.sentToAgent.length, 1, "the conflict was not handed to the agent");
		assert.match(r.sentToAgent[0], /left conflicts in:/);
		assert.match(r.sentToAgent[0], /contested\.txt/);
	});

	it("does nothing when the story belongs to no epic", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Unmanaged" });
		await applyTransitionEffects(r.session, null, { ...story, status: "done" });
		assert.equal(takeGitNotes(r.session), "");
		assert.equal(r.sentToAgent.length, 0);
	});
});

describe("closeCompletedParents", () => {
	it("closes an epic once its last child closes", async () => {
		const r = await repo();
		const epic = makeStory(r, { title: "Epic", status: "draft" });
		const a = makeStory(r, { title: "A", parent_id: epic.id });
		const b = makeStory(r, { title: "B", parent_id: epic.id });

		updateStory(r.db, a.id, { status: "done", resolution: "completed" });
		updateStory(r.db, b.id, { status: "done", resolution: "completed" });
		const closed = await closeCompletedParents(r.session, b.id);

		assert.deepEqual(closed.map((s) => s.id), [epic.id]);
		assert.equal(getStoryById(r.db, epic.id)!.status, "done");
		assert.equal(getStoryById(r.db, epic.id)!.resolution, "completed");
		assert.match(getStoryById(r.db, epic.id)!.resolution_note!, /All 2 child stories closed\./);
	});

	it("stops at an epic that still has an open child", async () => {
		const r = await repo();
		const epic = makeStory(r, { title: "Epic", status: "draft" });
		const a = makeStory(r, { title: "A", parent_id: epic.id });
		makeStory(r, { title: "B", parent_id: epic.id });

		updateStory(r.db, a.id, { status: "done", resolution: "completed" });
		assert.deepEqual(await closeCompletedParents(r.session, a.id), []);
		assert.equal(getStoryById(r.db, epic.id)!.status, "draft");
	});

	it("walks all the way up, closing each level whose children are all done", async () => {
		const r = await repo();
		const top = makeStory(r, { title: "Top", status: "draft" });
		const mid = makeStory(r, { title: "Mid", status: "draft", parent_id: top.id });
		const leaf = makeStory(r, { title: "Leaf", parent_id: mid.id });

		updateStory(r.db, leaf.id, { status: "done", resolution: "completed" });
		const closed = await closeCompletedParents(r.session, leaf.id);
		assert.deepEqual(closed.map((s) => s.id), [mid.id, top.id]);
	});

	it("stops at an ancestor that is already closed", async () => {
		const r = await repo();
		const top = makeStory(r, { title: "Top", status: "done" });
		const mid = makeStory(r, { title: "Mid", status: "draft", parent_id: top.id });
		const leaf = makeStory(r, { title: "Leaf", parent_id: mid.id });

		updateStory(r.db, leaf.id, { status: "done", resolution: "completed" });
		assert.deepEqual((await closeCompletedParents(r.session, leaf.id)).map((s) => s.id), [mid.id]);
	});

	/** Nothing in the tool path prevents A→B→A, and an unguarded walk would hang. */
	it("terminates on a parent cycle instead of looping forever", async () => {
		const r = await repo();
		const a = makeStory(r, { title: "A", status: "draft" });
		const b = makeStory(r, { title: "B", status: "draft", parent_id: a.id });
		updateStory(r.db, a.id, { parent_id: b.id });

		const leaf = makeStory(r, { title: "Leaf", parent_id: a.id });
		updateStory(r.db, leaf.id, { status: "done", resolution: "completed" });
		await closeCompletedParents(r.session, leaf.id);
		// The assertion is that this returned at all.
	});

	it("does nothing for a story with no parent", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Orphan" });
		assert.deepEqual(await closeCompletedParents(r.session, story.id), []);
	});
});

describe("rollUpHandoffNotes", () => {
	const epic = { title: "Add auth" } as Story;
	const child = (id: number, title: string, handoff_notes: string | null) =>
		({ id, title, handoff_notes }) as Story;

	it("gathers the children's notes under a heading naming the epic", () => {
		const note = rollUpHandoffNotes(epic, [child(1, "A", "watch the salt"), child(2, "B", "cookies expire")]);
		assert.match(note, /Epic "Add auth" — handoff notes from its 2 closed stories:/);
		assert.match(note, /#1 A: watch the salt/);
		assert.match(note, /#2 B: cookies expire/);
	});

	it("says 'story' for one and 'stories' for more", () => {
		assert.match(rollUpHandoffNotes(epic, [child(1, "A", "n")]), /its 1 closed story:/);
		assert.match(rollUpHandoffNotes(epic, [child(1, "A", "n"), child(2, "B", "m")]), /its 2 closed stories:/);
	});

	/** An epic with no note is a hole in the tree exactly where the summary belongs. */
	it("still produces a note when no child recorded one", () => {
		const note = rollUpHandoffNotes(epic, [child(1, "A", null), child(2, "B", "   ")]);
		assert.equal(note, 'Epic "Add auth" closed with 2 child stories; none recorded a handoff note.');
	});

	it("skips a child whose note is only whitespace, and counts only what it kept", () => {
		const note = rollUpHandoffNotes(epic, [child(1, "A", "real"), child(2, "B", "  ")]);
		assert.match(note, /its 1 closed story:/);
		assert.ok(!note.includes("#2"));
	});
});

describe("promoteNextStory", () => {
	it("promotes the next story to ready and describes it to the agent", async () => {
		const r = await repo();
		const next = makeStory(r, { title: "Second", status: "draft", sub_goal: "the next bit" });
		const closed = makeStory(r, { title: "First", next_id: next.id });

		const { note, promoted } = await promoteNextStory(r.session, getStoryById(r.db, closed.id)!);
		assert.equal(promoted?.id, next.id);
		assert.equal(getStoryById(r.db, next.id)!.status, "ready");
		assert.match(note, />>> NEXT UP: Story #\d+ is now READY\./);
		assert.match(note, /Sub-goal: the next bit/);
	});

	it("says what the next story is waiting on instead of silently stopping", async () => {
		const r = await repo();
		const blocker = makeStory(r, { title: "Blocker", status: "in_progress" });
		const next = makeStory(r, { title: "Second", status: "draft", depends_on: [blocker.id] });
		const closed = makeStory(r, { title: "First", next_id: next.id });

		const { note, promoted } = await promoteNextStory(r.session, getStoryById(r.db, closed.id)!);
		assert.equal(promoted, null);
		assert.equal(getStoryById(r.db, next.id)!.status, "draft");
		assert.match(note, new RegExp(`still waiting on dependencies: #${blocker.id}`));
	});

	it("says nothing when there is no next story", async () => {
		const r = await repo();
		const closed = makeStory(r, { title: "Last" });
		assert.deepEqual(await promoteNextStory(r.session, closed), { note: "", promoted: null });
	});

	it("leaves a next story that is already in progress alone", async () => {
		const r = await repo();
		const next = makeStory(r, { title: "Second", status: "in_progress" });
		const closed = makeStory(r, { title: "First", next_id: next.id });

		const { note, promoted } = await promoteNextStory(r.session, getStoryById(r.db, closed.id)!);
		assert.equal(promoted, null);
		assert.equal(note, "");
		assert.equal(getStoryById(r.db, next.id)!.status, "in_progress");
	});

	it("skips a next story that already closed", async () => {
		const r = await repo();
		const next = makeStory(r, { title: "Second", status: "done" });
		const closed = makeStory(r, { title: "First", next_id: next.id });
		assert.deepEqual(await promoteNextStory(r.session, getStoryById(r.db, closed.id)!), { note: "", promoted: null });
	});
});

describe("selectReadyStory", () => {
	it("returns the lowest-priority ready story", async () => {
		const r = await repo();
		makeStory(r, { title: "Later", priority: 5 });
		const first = makeStory(r, { title: "Sooner", priority: 1 });
		assert.equal(selectReadyStory(r.db)?.id, first.id);
	});

	it("never hands out an epic — a story with children is a container", async () => {
		const r = await repo();
		const epic = makeStory(r, { title: "Epic", priority: 0 });
		makeStory(r, { title: "Child", status: "draft", parent_id: epic.id, priority: 1 });
		const leaf = makeStory(r, { title: "Leaf", priority: 2 });
		assert.equal(selectReadyStory(r.db)?.id, leaf.id);
	});

	it("skips a story whose dependencies have not all closed", async () => {
		const r = await repo();
		const blocker = makeStory(r, { title: "Blocker", status: "in_progress", priority: 0 });
		makeStory(r, { title: "Blocked", priority: 1, depends_on: [blocker.id] });
		const free = makeStory(r, { title: "Free", priority: 2 });
		assert.equal(selectReadyStory(r.db)?.id, free.id);
	});

	it("hands out a story once its last dependency closes", async () => {
		const r = await repo();
		const blocker = makeStory(r, { title: "Blocker", status: "done", priority: 0 });
		const blocked = makeStory(r, { title: "Blocked", priority: 1, depends_on: [blocker.id] });
		assert.equal(selectReadyStory(r.db)?.id, blocked.id);
	});

	it("returns null when nothing is ready", async () => {
		const r = await repo();
		makeStory(r, { title: "Draft", status: "draft" });
		assert.equal(selectReadyStory(r.db), null);
	});
});

describe("openStoryCount", () => {
	it("counts everything that is not done, cancelled or archived", async () => {
		const r = await repo();
		makeStory(r, { title: "a", status: "draft" });
		makeStory(r, { title: "b", status: "ready" });
		makeStory(r, { title: "c", status: "in_progress" });
		makeStory(r, { title: "d", status: "done" });
		makeStory(r, { title: "e", status: "cancelled" });
		makeStory(r, { title: "f", status: "archived" });
		assert.equal(openStoryCount(r.db), 3);
	});
});
