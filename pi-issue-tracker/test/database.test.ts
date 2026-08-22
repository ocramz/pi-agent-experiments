import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	closeDb,
	createEpicBranch,
	createStory,
	getActiveEpicBranch,
	getEpicBranch,
	getEpicBranchByPath,
	getEpicBranchesByState,
	getStoryCommit,
	getStoryCommitsForEpic,
	openDb,
	recordStoryCommit,
	recordStoryStart,
	updateEpicBranch,
} from "../src/database.ts";

const dirs: string[] = [];
function tempDb(name = "stories.db") {
	const dir = mkdtempSync(join(tmpdir(), "pi-tracker-db-"));
	dirs.push(dir);
	return openDb(join(dir, ".pi", name));
}
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("openDb", () => {
	/**
	 * The old getDb cached one handle in a module variable and ignored the path
	 * on every later call, so a second database in the same process silently
	 * aliased the first — which is what made parallel tests impossible.
	 */
	it("returns independent handles for different paths", () => {
		const first = tempDb();
		const second = tempDb();
		createStory(first, {
			title: "only in the first",
			sub_goal: "s",
			proposed_changes: "",
			status: "draft",
			priority: 0,
			parent_id: null,
			next_id: null,
			depends_on: [],
		});
		const rows = second.prepare("SELECT COUNT(*) AS n FROM stories").get() as { n: number };
		assert.equal(rows.n, 0, "a second database must not see the first one's rows");
	});

	it("creates the parent directory and is safe to reopen", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tracker-db-"));
		dirs.push(dir);
		const path = join(dir, "nested", "deeper", "stories.db");
		closeDb(openDb(path));
		const reopened = openDb(path);
		assert.ok(reopened.prepare("SELECT 1 AS ok").get());
		closeDb(reopened);
	});

	it("closeDb tolerates a double close", () => {
		const db = tempDb();
		closeDb(db);
		closeDb(db);
	});
});

describe("epic_branches", () => {
	const input = {
		epic_id: 12,
		mode: "branch" as const,
		branch: "epic/12-add-auth",
		base_branch: "feat/test",
		base_commit: "a".repeat(40),
		path: null,
	};

	it("round-trips a record, parsing the setup JSON", () => {
		const db = tempDb();
		createEpicBranch(db, { ...input, setup: { hash: "abc", exit_code: 0 } });
		const stored = getEpicBranch(db, 12);
		assert.equal(stored?.branch, "epic/12-add-auth");
		assert.equal(stored?.state, "active", "a new epic starts active");
		assert.deepEqual(stored?.setup, { hash: "abc", exit_code: 0 });
	});

	it("defaults setup to an empty object", () => {
		const db = tempDb();
		createEpicBranch(db, input);
		assert.deepEqual(getEpicBranch(db, 12)?.setup, {});
	});

	it("finds the active epic and stops finding it once merged", () => {
		const db = tempDb();
		createEpicBranch(db, input);
		assert.equal(getActiveEpicBranch(db)?.epic_id, 12);

		updateEpicBranch(db, 12, { state: "merged" });
		assert.equal(getActiveEpicBranch(db), null);
		assert.equal(getEpicBranchesByState(db, "merged").length, 1);
	});

	it("looks a worktree up by path, so a session can tell where it is", () => {
		const db = tempDb();
		createEpicBranch(db, { ...input, mode: "worktree", path: "/tmp/wt/epic-12" });
		assert.equal(getEpicBranchByPath(db, "/tmp/wt/epic-12")?.epic_id, 12);
		assert.equal(getEpicBranchByPath(db, "/tmp/elsewhere"), null);
	});

	it("rejects an unknown state at the schema level", () => {
		const db = tempDb();
		createEpicBranch(db, input);
		assert.throws(() => updateEpicBranch(db, 12, { state: "bogus" as never }));
	});
});

describe("story_commits", () => {
	it("records a start commit and later the resulting commit", () => {
		const db = tempDb();
		recordStoryStart(db, 13, 12, "start-sha");
		assert.equal(getStoryCommit(db, 13)?.commit_sha, null, "no commit until the story closes");

		recordStoryCommit(db, 13, { commit_sha: "commit-sha", backup_ref: "refs/pi/backup/12/story-13" });
		const stored = getStoryCommit(db, 13);
		assert.equal(stored?.commit_sha, "commit-sha");
		assert.equal(stored?.start_commit, "start-sha");
	});

	/**
	 * start_commit is the undo target. Re-starting a story must not move it, or
	 * the work from the first attempt becomes unreachable.
	 */
	it("keeps the original start commit when a story is restarted", () => {
		const db = tempDb();
		recordStoryStart(db, 13, 12, "first-start");
		recordStoryStart(db, 13, 12, "second-start");
		assert.equal(getStoryCommit(db, 13)?.start_commit, "first-start");
	});

	it("lists every story commit for an epic in order", () => {
		const db = tempDb();
		recordStoryStart(db, 13, 12, "a");
		recordStoryStart(db, 14, 12, "b");
		recordStoryStart(db, 99, 77, "c");
		assert.deepEqual(
			getStoryCommitsForEpic(db, 12).map((r) => r.story_id),
			[13, 14],
		);
	});
});
