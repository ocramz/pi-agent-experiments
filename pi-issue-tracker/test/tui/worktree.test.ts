// Worktree mode through the real TUI.
//
// The half these cases exist for is the one no host test can reach: pi's session
// relocation. `/start-epic --worktree` forks the session into the new directory
// and switches to it, and `/merge-epic` switches back out before deleting that
// directory — neither of which is a function in src/, and both of which only
// work from a command handler.
//
// Assertions run after `close()`, like everywhere else in this tier, and target
// durable state: the directory on disk, the row in stories.db, the branch git
// reports. The screen is only used to establish that the command got as far as
// its own output.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { getEpicBranch, getStoryById } from "../../src/database.ts";
import { rowCount } from "./inspect.ts";
import { session } from "./session.ts";

describe("/start-epic --worktree", () => {
	it("W1 creates the worktree, records it, and leaves the main checkout alone", async (t) => {
		const s = await session(t, "stories");
		const epic = s.facts.epicId!;

		await s.command(`/start-epic ${epic} --worktree`);
		await s.expect(`epic #${epic} started on epic/${epic}-ship-the-widget`);
		await s.close();

		// These cases never send a message, so pi has written no session file and
		// the session cannot follow the epic into the worktree — see W10, which is
		// the live case that does have one. The epic is created either way, and
		// that is what is asserted here.
		const row = s.db((db) => getEpicBranch(db, epic));
		assert.equal(row?.mode, "worktree", "the epic is recorded as a worktree epic");
		assert.ok(row?.path, "and with the directory it lives in");
		assert.ok(existsSync(row!.path!), `${row!.path} should exist on disk`);
		assert.equal(s.db((db) => getStoryById(db, epic)?.status), "in_progress");

		assert.equal(
			await s.branch(),
			"feat/work",
			"the main checkout never moves in worktree mode — that is what lets a second epic run beside it",
		);
		assert.ok(
			(await s.piRefs("backup")).includes(`refs/pi/backup/${epic}/pre-start`),
			"a pre-start backup ref was written",
		);
	});

	it("W2 accepts the flag before the id", async (t) => {
		const s = await session(t, "stories");
		const epic = s.facts.epicId!;

		await s.command(`/start-epic --worktree ${epic}`);
		await s.expect(`epic #${epic} started on epic/${epic}-ship-the-widget`);
		await s.close();

		assert.equal(s.db((db) => getEpicBranch(db, epic))?.mode, "worktree");
	});

	/**
	 * The concurrency rule. A branch-mode epic owns the main checkout's HEAD so a
	 * second one is refused — but the same story started with `--worktree` goes
	 * ahead, because it touches nothing the first one is using.
	 */
	it("W3 starts a second epic in a worktree where branch mode would be refused", async (t) => {
		const s = await session(t, "twoEpicsOneActive");
		const other = s.facts.otherEpicId!;

		await s.command(`/start-epic ${other}`);
		await s.expect("is still active on this checkout");
		await s.command(`/start-epic ${other} --worktree`);
		await s.expect(`epic #${other} started on epic/${other}-ship-the-gadget`);
		await s.close();

		assert.equal(s.db((db) => rowCount(db, "epic_branches")), 2, "both epics are recorded");
		assert.equal(s.db((db) => getEpicBranch(db, s.facts.epicId!))?.state, "active");
		assert.equal(s.db((db) => getEpicBranch(db, other))?.state, "active");
		assert.match(
			await s.branch(),
			new RegExp(`^epic/${s.facts.epicId}-`),
			"the first epic still holds the main checkout",
		);
	});

	it("W4 refuses when the directory is already taken", async (t) => {
		const s = await session(t, "epicWorktreeActive");
		const epic = s.facts.epicId!;

		// Same story, same derived directory — and the epic is already running.
		await s.command(`/start-epic ${epic} --worktree`);
		await s.expect("already active");
		await s.close();

		assert.equal(s.db((db) => rowCount(db, "epic_branches")), 1, "no second row was written");
	});
});

describe("/merge-epic in worktree mode", () => {
	it("W5 merges from the main checkout and removes the worktree", async (t) => {
		const s = await session(t, "epicWorktreeOneCommit");
		const { epicId: epic, baseBranch: base, worktreePath } = s.facts;
		const tip = await s.git("rev-parse", `epic/${epic}-ship-the-widget`);

		await s.command(`/merge-epic ${epic}`);
		await s.expect(`Merge epic/${epic}-ship-the-widget into ${base}?`);
		await s.choose(0); // "Yes, fast-forward <base>"
		await s.expect(`merged epic/${epic}-ship-the-widget into ${base}`);
		await s.expect("removed the worktree at");
		await s.choose(0); // "No, keep them" — pruning is offered, never assumed
		await s.close();

		assert.equal(await s.git("rev-parse", base!), tip, "the base branch fast-forwarded to the epic tip");
		assert.equal(s.db((db) => getEpicBranch(db, epic!))?.state, "merged");
		assert.ok(!existsSync(worktreePath!), "the worktree directory is gone");
		assert.equal(
			s.db((db) => getEpicBranch(db, epic!))?.path,
			null,
			"path is non-null exactly while the worktree exists",
		);
		assert.ok(
			s.exists("widget.ts"),
			"the merge landed in the main checkout's tree, which is sitting on the base branch",
		);
	});

	it("W6 keeps the merge undoable after pruning the rest of the refs", async (t) => {
		const s = await session(t, "epicWorktreeOneCommit");
		const { epicId: epic, baseBranch: base } = s.facts;
		const baseBefore = await s.git("rev-parse", base!);

		await s.command(`/merge-epic ${epic}`);
		await s.expect(`Merge epic/${epic}-ship-the-widget into ${base}?`);
		await s.choose(0);
		await s.expect(`merged epic/${epic}-ship-the-widget into ${base}`);
		await s.choose(1); // "Yes, prune all but pre-merge"
		await s.expect(`Pruned`);

		await s.command(`/undo-merge ${epic}`);
		await s.expect(`${base} restored to`);
		await s.close();

		assert.equal(await s.git("rev-parse", base!), baseBefore, "the base branch is exactly where it started");
		assert.equal(s.db((db) => getEpicBranch(db, epic!))?.state, "active");
		assert.deepEqual(
			await s.piRefs(`backup/${epic}`),
			[`refs/pi/backup/${epic}/pre-merge`],
			"everything but the ref /undo-merge depends on was pruned",
		);
	});
});

describe("/cancel-epic in worktree mode", () => {
	it("W7 removes the worktree without moving the main checkout", async (t) => {
		const s = await session(t, "epicWorktreeActive");
		const { epicId: epic, worktreePath } = s.facts;

		await s.command(`/cancel-epic ${epic}`);
		await s.expect(`epic #${epic} cancelled`);
		await s.choose(0); // "No, keep them"
		await s.close();

		assert.ok(!existsSync(worktreePath!), "the worktree directory is gone");
		assert.equal(await s.branch(), "feat/work", "the main checkout never moved");
		const row = s.db((db) => getEpicBranch(db, epic!));
		assert.equal(row?.state, "cancelled");
		assert.equal(row?.path, null);
		assert.ok(
			(await s.piRefs("backup")).includes(`refs/pi/backup/${epic}/pre-cancel`),
			"the abandoned work is still reachable",
		);
	});
});

describe("session scoping", () => {
	/**
	 * A session in the main checkout does not own a worktree epic, so the
	 * commands that default to "this session's epic" must not silently pick it
	 * up. Getting this wrong would let a session merge an epic belonging to
	 * another session standing in another directory.
	 */
	it("W8 does not treat another session's worktree epic as its own", async (t) => {
		const s = await session(t, "epicWorktreeActive");

		await s.command("/merge-epic");
		await s.expect("this session is not working on an epic");
		await s.command("/undo-turn");
		await s.expect("This session is not working on an epic");
		await s.close();

		assert.equal(
			s.db((db) => getEpicBranch(db, s.facts.epicId!))?.state,
			"active",
			"the other session's epic is untouched",
		);
	});
});
