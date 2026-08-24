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
	getStoriesWithHandoffNotes,
	getStoryById,
	getStoryCommit,
	getStoryCommitsForEpic,
	missingStoryColumns,
	openDb,
	recordStoryCommit,
	recordStoryStart,
	updateEpicBranch,
	updateStory,
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

describe("stories: review and handoff columns", () => {
	const make = (db: ReturnType<typeof tempDb>, overrides: Record<string, unknown> = {}) =>
		createStory(db, {
			title: "Add auth",
			sub_goal: "sign in",
			proposed_changes: "a login route",
			status: "draft",
			priority: 0,
			parent_id: null,
			next_id: null,
			depends_on: [],
			...overrides,
		});

	it("defaults review to an empty object and handoff_notes to null", () => {
		const story = make(tempDb());
		assert.deepEqual(story.review, {});
		assert.equal(story.handoff_notes, null);
	});

	/**
	 * updateStory builds its SET clause from object keys and JSON-encodes only
	 * the columns it knows are JSON. A column missing from that set binds
	 * "[object Object]" and the write is lost silently — which is exactly what
	 * this asserts against.
	 */
	it("round-trips a review record through updateStory", () => {
		const db = tempDb();
		const story = make(db);
		const record = { verdict: "approved" as const, findings: "scope is clear", by: "anthropic/x", at: 1700 };
		const updated = updateStory(db, story.id, { review: { plan: record } });
		assert.deepEqual(updated?.review.plan, record);
		assert.deepEqual(getStoryById(db, story.id)?.review.plan, record, "and survives a re-read");
	});

	it("keeps both gates independently", () => {
		const db = tempDb();
		const story = make(db);
		updateStory(db, story.id, { review: { plan: { verdict: "approved", findings: "a", by: "self", at: 1 } } });
		const before = getStoryById(db, story.id)!;
		updateStory(db, story.id, {
			review: { ...before.review, work: { verdict: "changes_requested", findings: "b", by: "self", at: 2 } },
		});
		const after = getStoryById(db, story.id)!;
		assert.equal(after.review.plan?.verdict, "approved");
		assert.equal(after.review.work?.verdict, "changes_requested");
	});

	it("reads a malformed review blob as empty rather than making the story unreadable", () => {
		const db = tempDb();
		const story = make(db);
		db.prepare("UPDATE stories SET review = ? WHERE id = ?").run("not json at all", story.id);
		assert.deepEqual(getStoryById(db, story.id)?.review, {});
	});

	it("round-trips handoff_notes", () => {
		const db = tempDb();
		const story = make(db);
		updateStory(db, story.id, { handoff_notes: "the limiter is keyed by IP" });
		assert.equal(getStoryById(db, story.id)?.handoff_notes, "the limiter is keyed by IP");
	});
});

describe("getStoriesWithHandoffNotes", () => {
	const make = (db: ReturnType<typeof tempDb>, title: string) =>
		createStory(db, {
			title,
			sub_goal: "",
			proposed_changes: "",
			status: "draft",
			priority: 0,
			parent_id: null,
			next_id: null,
			depends_on: [],
		});

	it("returns nothing when no story has a note", () => {
		const db = tempDb();
		make(db, "one");
		assert.deepEqual(getStoriesWithHandoffNotes(db), []);
	});

	it("excludes null and whitespace-only notes", () => {
		const db = tempDb();
		const blank = make(db, "blank");
		const real = make(db, "real");
		updateStory(db, blank.id, { handoff_notes: "   " });
		updateStory(db, real.id, { handoff_notes: "something worth knowing" });
		const found = getStoriesWithHandoffNotes(db);
		assert.equal(found.length, 1);
		assert.equal(found[0].id, real.id);
	});

	it("orders by most recently updated first", () => {
		const db = tempDb();
		const first = make(db, "first");
		const second = make(db, "second");
		updateStory(db, first.id, { handoff_notes: "older" });
		db.prepare("UPDATE stories SET updated_at = ? WHERE id = ?").run(1000, first.id);
		updateStory(db, second.id, { handoff_notes: "newer" });
		db.prepare("UPDATE stories SET updated_at = ? WHERE id = ?").run(2000, second.id);
		assert.deepEqual(
			getStoriesWithHandoffNotes(db).map((s) => s.id),
			[second.id, first.id],
		);
	});
});

describe("missingStoryColumns", () => {
	it("reports nothing against a database this version created", () => {
		assert.deepEqual(missingStoryColumns(tempDb()), []);
	});

	/**
	 * INIT_SQL is all CREATE TABLE IF NOT EXISTS and there are no migrations, so
	 * a database written before these columns existed keeps its old shape. The
	 * extension detects that and prints the documented fix instead of throwing
	 * `no such column` on every turn.
	 */
	it("names the columns an older database is missing", () => {
		const db = tempDb();
		db.exec("DROP TABLE stories");
		db.exec(`CREATE TABLE stories (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			title TEXT NOT NULL, sub_goal TEXT NOT NULL, proposed_changes TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft', priority INTEGER NOT NULL DEFAULT 0,
			parent_id INTEGER, next_id INTEGER, depends_on TEXT NOT NULL DEFAULT '[]',
			resolution TEXT, resolution_note TEXT, learnings TEXT,
			created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
		)`);
		assert.deepEqual(missingStoryColumns(db), ["review", "handoff_notes"]);
	});
});
