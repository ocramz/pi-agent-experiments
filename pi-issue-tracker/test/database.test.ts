import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	closeDb,
	createEpicBranch,
	createStory,
	getActiveBranchModeEpic,
	getActiveEpicBranches,
	getEpicBranch,
	getEpicBranchByPath,
	getEpicBranchesByState,
	getLastMergedEpicBranch,
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

	it("finds the active branch-mode epic and stops finding it once merged", () => {
		const db = tempDb();
		createEpicBranch(db, input);
		assert.equal(getActiveBranchModeEpic(db)?.epic_id, 12);

		updateEpicBranch(db, 12, { state: "merged" });
		assert.equal(getActiveBranchModeEpic(db), null);
		assert.equal(getEpicBranchesByState(db, "merged").length, 1);
	});

	/**
	 * The whole point of worktree mode. A branch-mode epic owns the main
	 * checkout's HEAD so only one can exist, but it must not hide the worktree
	 * epics running beside it — and they must not be mistaken for it.
	 */
	it("lists every active epic while reporting only one as holding the main checkout", () => {
		const db = tempDb();
		createEpicBranch(db, input, 1_000);
		createEpicBranch(
			db,
			{ ...input, epic_id: 13, mode: "worktree", branch: "epic/13-b", path: "/wt/epic-13-b" },
			2_000,
		);
		createEpicBranch(
			db,
			{ ...input, epic_id: 14, mode: "worktree", branch: "epic/14-c", path: "/wt/epic-14-c" },
			3_000,
		);

		assert.deepEqual(
			getActiveEpicBranches(db).map((epic) => epic.epic_id),
			[12, 13, 14],
		);
		assert.equal(getActiveBranchModeEpic(db)?.epic_id, 12);
	});

	/**
	 * `created_at` and `updated_at` used to default to
	 * `strftime('%s','now') * 1000` — millisecond scale at second resolution —
	 * so two epics created in the same second tied and the order fell back to
	 * rowid. Writing the value from the caller's clock is what makes this
	 * answerable at all.
	 */
	it("takes its timestamps from the caller, at millisecond resolution", () => {
		const db = tempDb();
		const created = createEpicBranch(db, input, 1_700_000_000_001);
		assert.equal(created.created_at, 1_700_000_000_001);
		assert.equal(created.updated_at, 1_700_000_000_001);

		const updated = updateEpicBranch(db, 12, { state: "merged" }, 1_700_000_000_002);
		assert.equal(updated?.created_at, 1_700_000_000_001, "created_at must not move");
		assert.equal(updated?.updated_at, 1_700_000_000_002);
	});

	/**
	 * `/undo-merge` with no id wants the epic that merged *last*, which is a
	 * question about `updated_at`. Ordering by `created_at` answers "which
	 * started last" and gives a different epic the moment two of them run
	 * concurrently.
	 */
	it("picks the last merged epic by when it merged, not by when it started", () => {
		const db = tempDb();
		createEpicBranch(db, input, 1_000);
		createEpicBranch(db, { ...input, epic_id: 13, branch: "epic/13-b" }, 2_000);

		// The one started first is merged second.
		updateEpicBranch(db, 13, { state: "merged" }, 3_000);
		updateEpicBranch(db, 12, { state: "merged" }, 4_000);

		assert.equal(getLastMergedEpicBranch(db)?.epic_id, 12);
		assert.deepEqual(
			getEpicBranchesByState(db, "merged").map((epic) => epic.epic_id),
			[13, 12],
			"oldest merge first",
		);
	});

	it("has no last merged epic before anything has merged", () => {
		const db = tempDb();
		createEpicBranch(db, input);
		assert.equal(getLastMergedEpicBranch(db), null);
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
