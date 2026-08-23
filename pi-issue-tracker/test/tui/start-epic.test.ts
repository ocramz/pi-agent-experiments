// /start-epic — one case per refusal in checkCanStartEpic, plus the dirty-tree
// prompt both ways and --worktree.
//
// The refusals are the point of this file. Each one asserts two things: that the
// message was shown, and that no side effect fired. The manual suite could only
// machine-check the second half and had to ask the operator about the first.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getEpicBranch, getStoryById } from "../../src/database.ts";
import { rowCount } from "./inspect.ts";
import { session } from "./pi-session.ts";

describe("/start-epic", () => {
	it("D1 creates the branch, backup ref and in_progress status", async (t) => {
		const s = await session(t, "stories");
		const epic = s.facts.epicId!;
		await s.command(`/start-epic ${epic}`);
		await s.expect(`epic #${epic} started on epic/${epic}-ship-the-widget`);
		await s.close();

		assert.match(await s.branch(), new RegExp(`^epic/${epic}-`), "HEAD moved to the epic branch");
		assert.equal(s.db((db) => getEpicBranch(db, epic)?.state), "active", "the epic is recorded as active");
		assert.equal(s.db((db) => getStoryById(db, epic)?.status), "in_progress", "the story is in progress");
		assert.ok(
			(await s.piRefs("backup")).includes(`refs/pi/backup/${epic}/pre-start`),
			"a pre-start backup ref was written",
		);
	});

	it("D2 refuses outside a git repository", async (t) => {
		const s = await session(t, "notRepo");
		await s.command("/start-epic 1");
		await s.expect("not a git repository");
		await s.close();

		assert.equal(s.exists(".git"), false, "no repository was created");
	});

	it("D3 refuses on a detached HEAD", async (t) => {
		const s = await session(t, "detached");
		await s.command(`/start-epic ${s.facts.epicId}`);
		await s.expect("Cannot start epic: HEAD is detached");
		await s.close();

		assert.equal(await s.branch(), "", "HEAD is still detached");
		assert.equal(s.db((db) => rowCount(db, "epic_branches")), 0, "no epic was recorded");
	});

	it("D4 refuses on a protected branch", async (t) => {
		const s = await session(t, "onMain");
		await s.command(`/start-epic ${s.facts.epicId}`);
		await s.expect("refusing to start an epic from main");
		await s.close();

		assert.equal(await s.branch(), "main", "still on the protected branch");
		assert.equal(s.db((db) => rowCount(db, "epic_branches")), 0, "no epic was recorded");
	});

	it("D5 refuses a story with no children", async (t) => {
		const s = await session(t, "stories");
		const loose = s.facts.looseId!;
		await s.command(`/start-epic ${loose}`);
		await s.expect(`story #${loose} is a unit of work, not an epic`);
		await s.close();

		assert.equal(await s.branch(), "feat/work", "no branch was created");
		assert.equal(s.db((db) => rowCount(db, "epic_branches")), 0, "no epic was recorded");
	});

	it("D6 refuses a second branch-mode epic and points at the mode that works", async (t) => {
		const s = await session(t, "twoEpicsOneActive");
		const before = await s.branch();
		await s.command(`/start-epic ${s.facts.otherEpicId}`);
		await s.expect(`epic #${s.facts.epicId} is still active on this checkout`);
		// The refusal is about the main checkout, not about epics in general —
		// see W3, which starts this very epic in a worktree instead.
		await s.expect("--worktree");
		await s.close();

		assert.equal(await s.branch(), before, "still on the first epic's branch");
		assert.equal(s.db((db) => rowCount(db, "epic_branches")), 1, "only one epic exists");
	});

	it("D7 offers to carry a dirty tree, and declining changes nothing", async (t) => {
		const s = await session(t, "dirty");
		await s.command(`/start-epic ${s.facts.epicId}`);
		await s.expect("You have uncommitted changes. Carry them onto the epic branch?");
		await s.choose(1); // "No, let me handle them first"
		await s.expect("Commit or stash your changes, then run /start-epic again.");
		await s.close();

		assert.equal(await s.branch(), "feat/work", "still on the original branch");
		assert.equal(s.db((db) => rowCount(db, "epic_branches")), 0, "no epic was recorded");
		assert.match(await s.git("status", "--porcelain"), /scratch\.txt/, "the uncommitted file is untouched");
	});

	it("D8 carries the dirty tree when accepted", async (t) => {
		const s = await session(t, "dirty");
		const epic = s.facts.epicId!;
		await s.command(`/start-epic ${epic}`);
		await s.expect("You have uncommitted changes. Carry them onto the epic branch?");
		await s.choose(0); // "Yes, commit them as the epic's first commit"
		await s.expect("existing changes carried into the first commit");
		await s.close();

		assert.match(await s.branch(), new RegExp(`^epic/${epic}-`), "HEAD moved to the epic branch");
		assert.equal(await s.git("status", "--porcelain"), "", "the working tree is clean");
		assert.match(
			await s.git("show", "--name-only", "--pretty=format:", "HEAD"),
			/scratch\.txt/,
			"the carried change is committed",
		);
	});

	/**
	 * The id used to be read as `args.split(/\s+/)[0]`, so a flag written first
	 * would have been parsed as the story id the moment worktree mode existed.
	 */
	it("D9 rejects a missing story id whichever side the flag is on", async (t) => {
		const s = await session(t, "stories");
		await s.command("/start-epic --worktree");
		await s.expect("Usage: /start-epic <story_id>");
		await s.close();

		assert.equal(await s.branch(), "feat/work", "no branch was created");
		assert.equal(s.db((db) => rowCount(db, "epic_branches")), 0, "no epic was recorded");
	});
});
