import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type EpicBranch,
	type EpicMode,
	type EpicSetupRecord,
	type EpicState,
	type Story,
	type StoryCommit,
	type StoryHistoryEntry,
	type StoryResolution,
} from "./types.ts";

/** node:sqlite does not export SQLInputValue; this covers everything we bind. */
type SqlValue = null | number | bigint | string;

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  sub_goal TEXT NOT NULL,
  proposed_changes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'ready', 'in_progress', 'done', 'cancelled', 'archived')),
  priority INTEGER NOT NULL DEFAULT 0,
  parent_id INTEGER,
  next_id INTEGER,
  depends_on TEXT NOT NULL DEFAULT '[]',
  resolution TEXT,
  resolution_note TEXT,
  learnings TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);
CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(status);
CREATE INDEX IF NOT EXISTS idx_stories_priority ON stories(priority);
CREATE INDEX IF NOT EXISTS idx_stories_parent ON stories(parent_id);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS story_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- The branch (and optionally worktree) an epic's work happens on.
-- The setup column is JSON on purpose: new fields land there, not in a migration.
CREATE TABLE IF NOT EXISTS epic_branches (
  epic_id     INTEGER PRIMARY KEY,
  mode        TEXT NOT NULL DEFAULT 'branch' CHECK(mode IN ('branch', 'worktree')),
  branch      TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  path        TEXT,
  state       TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'merged', 'cancelled')),
  setup       TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);
CREATE INDEX IF NOT EXISTS idx_epic_branches_state ON epic_branches(state);

-- What a story started from and what it produced, so it can be undone.
CREATE TABLE IF NOT EXISTS story_commits (
  story_id     INTEGER PRIMARY KEY,
  epic_id      INTEGER NOT NULL,
  start_commit TEXT NOT NULL,
  commit_sha   TEXT,
  backup_ref   TEXT,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);
CREATE INDEX IF NOT EXISTS idx_story_commits_epic ON story_commits(epic_id);
`;

/**
 * Open a database at `dbPath`.
 *
 * Returns a fresh handle every call. The previous module-level singleton ignored
 * its argument after the first call, so one process could never hold two
 * databases — which made parallel tests impossible. Callers that want one handle
 * per path cache it themselves.
 */
export function openDb(dbPath: string): DatabaseSync {
	mkdirSync(dirname(dbPath), { recursive: true });
	const handle = new DatabaseSync(dbPath);
	// Several worktrees and sessions can share one file; node:sqlite defaults to
	// a rollback journal, which turns concurrent writes into SQLITE_BUSY.
	handle.exec("PRAGMA journal_mode = WAL;");
	handle.exec("PRAGMA busy_timeout = 5000;");
	handle.exec(INIT_SQL);
	return handle;
}

export function closeDb(handle: DatabaseSync | null): void {
	if (!handle) return;
	try {
		handle.close();
	} catch {
		// Already closed, or the file went away under us. Nothing to recover.
	}
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
	db.exec("BEGIN");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

function rowToStory(row: Record<string, unknown>): Story {
	return {
		id: row.id as number,
		title: row.title as string,
		sub_goal: row.sub_goal as string,
		proposed_changes: row.proposed_changes as string,
		status: row.status as Story["status"],
		priority: row.priority as number,
		parent_id: (row.parent_id as number | null) ?? null,
		next_id: (row.next_id as number | null) ?? null,
		depends_on: JSON.parse((row.depends_on as string) ?? "[]") as number[],
		resolution: (row.resolution as StoryResolution | null) ?? null,
		resolution_note: (row.resolution_note as string | null) ?? null,
		learnings: (row.learnings as string | null) ?? null,
		created_at: row.created_at as number,
		updated_at: row.updated_at as number,
	};
}

/** Outcome fields default to null, so most callers can omit them. */
export type CreateStoryInput = Omit<
	Story,
	"id" | "created_at" | "updated_at" | "resolution" | "resolution_note" | "learnings"
> &
	Partial<Pick<Story, "resolution" | "resolution_note" | "learnings">>;

export function createStory(db: DatabaseSync, data: CreateStoryInput): Story {
	const stmt = db.prepare(
		`INSERT INTO stories (title, sub_goal, proposed_changes, status, priority, parent_id, next_id, depends_on, resolution, resolution_note, learnings)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
	);
	const row = stmt.get(
		data.title,
		data.sub_goal,
		data.proposed_changes,
		data.status,
		data.priority,
		data.parent_id,
		data.next_id,
		JSON.stringify(data.depends_on ?? []),
		data.resolution ?? null,
		data.resolution_note ?? null,
		data.learnings ?? null,
	) as Record<string, unknown>;

	const story = rowToStory(row);
	logHistory(db, story.id, "create", null, JSON.stringify(story));
	return story;
}

export function updateStory(db: DatabaseSync, id: number, updates: Partial<Omit<Story, "id" | "created_at" | "updated_at">>): Story | null {
	const existing = getStoryById(db, id);
	if (!existing) return null;

	const setClauses: string[] = [];
	const values: SqlValue[] = [];

	for (const [key, value] of Object.entries(updates)) {
		// Skip absent keys before dispatching on name — `JSON.stringify(undefined)`
		// is `undefined`, which cannot be bound as a SQLite parameter.
		if (value === undefined) continue;
		setClauses.push(`${key} = ?`);
		values.push(key === "depends_on" ? JSON.stringify(value) : (value as SqlValue));
	}
	if (setClauses.length === 0) return existing;

	setClauses.push(`updated_at = strftime('%s', 'now') * 1000`);
	values.push(id);

	const sql = `UPDATE stories SET ${setClauses.join(", ")} WHERE id = ? RETURNING *`;
	const stmt = db.prepare(sql);
	const row = stmt.get(...values) as Record<string, unknown>;
	if (!row) return null;

	const story = rowToStory(row);
	logHistory(db, story.id, "update", JSON.stringify(existing), JSON.stringify(story));
	return story;
}

export function getStoryById(db: DatabaseSync, id: number): Story | null {
	const stmt = db.prepare("SELECT * FROM stories WHERE id = ?");
	const row = stmt.get(id) as Record<string, unknown> | undefined;
	return row ? rowToStory(row) : null;
}

export function getAllStories(db: DatabaseSync): Story[] {
	const stmt = db.prepare("SELECT * FROM stories ORDER BY priority ASC, id ASC");
	const rows = stmt.all() as Record<string, unknown>[];
	return rows.map(rowToStory);
}

export function getStoriesByStatus(db: DatabaseSync, status: Story["status"]): Story[] {
	const stmt = db.prepare("SELECT * FROM stories WHERE status = ? ORDER BY priority ASC, id ASC");
	const rows = stmt.all(status) as Record<string, unknown>[];
	return rows.map(rowToStory);
}

/** True if any story names `id` as its parent — i.e. `id` is an epic, not a unit of work. */
export function hasChildren(db: DatabaseSync, id: number): boolean {
	const stmt = db.prepare("SELECT 1 FROM stories WHERE parent_id = ? LIMIT 1");
	return stmt.get(id) !== undefined;
}

/**
 * True if making `parentId` the parent of `childId` would close a loop.
 * Also catches a pre-existing cycle, so a corrupt graph can't hang the walk.
 */
export function wouldCreateCycle(db: DatabaseSync, childId: number, parentId: number): boolean {
	const seen = new Set<number>();
	let cursor: number | null = parentId;
	while (cursor !== null) {
		if (cursor === childId) return true;
		if (seen.has(cursor)) return true;
		seen.add(cursor);
		cursor = getStoryById(db, cursor)?.parent_id ?? null;
	}
	return false;
}

export function getChildren(db: DatabaseSync, id: number): Story[] {
	const stmt = db.prepare("SELECT * FROM stories WHERE parent_id = ? ORDER BY priority ASC, id ASC");
	const rows = stmt.all(id) as Record<string, unknown>[];
	return rows.map(rowToStory);
}

/** Closed stories that recorded a learning, most recently updated first. */
export function getStoriesWithLearnings(db: DatabaseSync): Story[] {
	const stmt = db.prepare(
		"SELECT * FROM stories WHERE learnings IS NOT NULL AND TRIM(learnings) != '' ORDER BY updated_at DESC",
	);
	const rows = stmt.all() as Record<string, unknown>[];
	return rows.map(rowToStory);
}

/** Highest priority currently in use, or -1 when the table is empty. */
export function getMaxPriority(db: DatabaseSync): number {
	const row = db.prepare("SELECT MAX(priority) AS max FROM stories").get() as { max: number | null };
	return row.max ?? -1;
}

export function searchStories(db: DatabaseSync, query: string): Story[] {
	const like = `%${query.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
	const stmt = db.prepare(
		`SELECT * FROM stories WHERE title LIKE ? OR sub_goal LIKE ? OR proposed_changes LIKE ? ORDER BY priority ASC, id ASC`,
	);
	const rows = stmt.all(like, like, like) as Record<string, unknown>[];
	return rows.map(rowToStory);
}

export function deleteStories(db: DatabaseSync, ids: number[]): void {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => "?").join(",");
	const stmt = db.prepare(`DELETE FROM stories WHERE id IN (${placeholders})`);
	stmt.run(...ids);
	for (const id of ids) {
		logHistory(db, id, "delete", null, null);
	}
}

export function logHistory(db: DatabaseSync, storyId: number, action: string, oldValue: string | null, newValue: string | null): void {
	const stmt = db.prepare("INSERT INTO story_history (story_id, action, old_value, new_value) VALUES (?, ?, ?, ?)");
	stmt.run(storyId, action, oldValue, newValue);
}

export function getHistory(db: DatabaseSync, storyId: number): StoryHistoryEntry[] {
	const stmt = db.prepare("SELECT * FROM story_history WHERE story_id = ? ORDER BY timestamp DESC");
	const rows = stmt.all(storyId) as Record<string, unknown>[];
	return rows.map((row) => ({
		id: row.id as number,
		story_id: row.story_id as number,
		action: row.action as string,
		old_value: (row.old_value as string | null) ?? null,
		new_value: (row.new_value as string | null) ?? null,
		timestamp: row.timestamp as number,
	}));
}

export function getAppState(db: DatabaseSync, key: string): string | null {
	const stmt = db.prepare("SELECT value FROM app_state WHERE key = ?");
	const row = stmt.get(key) as { value: string } | undefined;
	return row?.value ?? null;
}

export function setAppState(db: DatabaseSync, key: string, value: string): void {
	const stmt = db.prepare(
		"INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	);
	stmt.run(key, value);
}

// ─── Epic branches ──────────────────────────────────────────────────

function rowToEpicBranch(row: Record<string, unknown>): EpicBranch {
	let setup: EpicSetupRecord = {};
	try {
		setup = JSON.parse((row.setup as string) ?? "{}") as EpicSetupRecord;
	} catch {
		// A hand-edited or truncated value should not take the extension down.
	}
	return {
		epic_id: row.epic_id as number,
		mode: row.mode as EpicMode,
		branch: row.branch as string,
		base_branch: row.base_branch as string,
		base_commit: row.base_commit as string,
		path: (row.path as string | null) ?? null,
		state: row.state as EpicState,
		setup,
		created_at: row.created_at as number,
		updated_at: row.updated_at as number,
	};
}

export type CreateEpicBranchInput = Omit<EpicBranch, "created_at" | "updated_at" | "state" | "setup"> &
	Partial<Pick<EpicBranch, "state" | "setup">>;

/**
 * The timestamp is written by the caller, not left to the column default.
 *
 * `DEFAULT (strftime('%s','now') * 1000)` is millisecond *scale* at second
 * *resolution*: two epics created in the same second hold identical values, and
 * every ordering that falls back on them degenerates to rowid. It also ignores
 * `TrackerContext.now`, so a test could not control the clock. Passing `now`
 * here fixes both. The column defaults stay because `INIT_SQL` is
 * `CREATE TABLE IF NOT EXISTS` and there are no migrations — they simply stop
 * being the path that runs.
 */
export function createEpicBranch(
	db: DatabaseSync,
	data: CreateEpicBranchInput,
	now: number = Date.now(),
): EpicBranch {
	const stmt = db.prepare(
		`INSERT INTO epic_branches (epic_id, mode, branch, base_branch, base_commit, path, state, setup, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
	);
	const row = stmt.get(
		data.epic_id,
		data.mode,
		data.branch,
		data.base_branch,
		data.base_commit,
		data.path,
		data.state ?? "active",
		JSON.stringify(data.setup ?? {}),
		now,
		now,
	) as Record<string, unknown>;
	return rowToEpicBranch(row);
}

export function getEpicBranch(db: DatabaseSync, epicId: number): EpicBranch | null {
	const row = db.prepare("SELECT * FROM epic_branches WHERE epic_id = ?").get(epicId) as
		| Record<string, unknown>
		| undefined;
	return row ? rowToEpicBranch(row) : null;
}

/**
 * Every epic still being worked on.
 *
 * Several can be active at once: branch mode allows one, and each worktree epic
 * adds another. This is what the start gate reasons over — see
 * `checkCanStartEpic` in src/rules.ts.
 */
export function getActiveEpicBranches(db: DatabaseSync): EpicBranch[] {
	const rows = db
		.prepare("SELECT * FROM epic_branches WHERE state = 'active' ORDER BY created_at ASC, epic_id ASC")
		.all() as Record<string, unknown>[];
	return rows.map(rowToEpicBranch);
}

/**
 * The active epic occupying the *main* checkout.
 *
 * At most one can exist, because a branch-mode epic owns the main working tree's
 * HEAD and two of them would fight over it. Worktree epics are invisible here on
 * purpose: they never touch the main checkout, which is exactly what lets them
 * run concurrently.
 */
export function getActiveBranchModeEpic(db: DatabaseSync): EpicBranch | null {
	const row = db
		.prepare(
			"SELECT * FROM epic_branches WHERE state = 'active' AND mode = 'branch' ORDER BY created_at DESC, epic_id DESC LIMIT 1",
		)
		.get() as Record<string, unknown> | undefined;
	return row ? rowToEpicBranch(row) : null;
}

/** Ordered oldest first by when each row last changed. */
export function getEpicBranchesByState(db: DatabaseSync, state: EpicState): EpicBranch[] {
	const rows = db
		.prepare("SELECT * FROM epic_branches WHERE state = ? ORDER BY updated_at ASC, epic_id ASC")
		.all(state) as Record<string, unknown>[];
	return rows.map(rowToEpicBranch);
}

/**
 * The epic whose merge landed most recently — what `/undo-merge` means by "the
 * last one".
 *
 * Ordered by `updated_at`, not `created_at`: those answer different questions
 * ("which merged last" versus "which started last") and only coincided while a
 * single epic could be active at a time.
 */
export function getLastMergedEpicBranch(db: DatabaseSync): EpicBranch | null {
	const row = db
		.prepare("SELECT * FROM epic_branches WHERE state = 'merged' ORDER BY updated_at DESC, epic_id DESC LIMIT 1")
		.get() as Record<string, unknown> | undefined;
	return row ? rowToEpicBranch(row) : null;
}

/** Find the epic whose worktree contains `path`, so a session can tell where it is. */
export function getEpicBranchByPath(db: DatabaseSync, path: string): EpicBranch | null {
	const row = db.prepare("SELECT * FROM epic_branches WHERE path = ?").get(path) as
		| Record<string, unknown>
		| undefined;
	return row ? rowToEpicBranch(row) : null;
}

/** `now` is caller-supplied for the same reason as in `createEpicBranch`. */
export function updateEpicBranch(
	db: DatabaseSync,
	epicId: number,
	updates: Partial<Pick<EpicBranch, "state" | "setup" | "path" | "base_commit">>,
	now: number = Date.now(),
): EpicBranch | null {
	const setClauses: string[] = [];
	const values: SqlValue[] = [];
	for (const [key, value] of Object.entries(updates)) {
		if (value === undefined) continue;
		setClauses.push(`${key} = ?`);
		values.push(key === "setup" ? JSON.stringify(value) : (value as SqlValue));
	}
	if (setClauses.length === 0) return getEpicBranch(db, epicId);

	setClauses.push("updated_at = ?");
	values.push(now, epicId);
	const row = db
		.prepare(`UPDATE epic_branches SET ${setClauses.join(", ")} WHERE epic_id = ? RETURNING *`)
		.get(...values) as Record<string, unknown> | undefined;
	return row ? rowToEpicBranch(row) : null;
}

// ─── Story commits ──────────────────────────────────────────────────

function rowToStoryCommit(row: Record<string, unknown>): StoryCommit {
	return {
		story_id: row.story_id as number,
		epic_id: row.epic_id as number,
		start_commit: row.start_commit as string,
		commit_sha: (row.commit_sha as string | null) ?? null,
		backup_ref: (row.backup_ref as string | null) ?? null,
		created_at: row.created_at as number,
	};
}

/**
 * Record where a story began. Re-starting a story keeps the original
 * `start_commit`: it is the undo target, and moving it would strand the work
 * done in the first attempt.
 */
export function recordStoryStart(
	db: DatabaseSync,
	storyId: number,
	epicId: number,
	startCommit: string,
	now: number = Date.now(),
): StoryCommit {
	const row = db
		.prepare(
			`INSERT INTO story_commits (story_id, epic_id, start_commit, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(story_id) DO UPDATE SET epic_id = excluded.epic_id
       RETURNING *`,
		)
		.get(storyId, epicId, startCommit, now) as Record<string, unknown>;
	return rowToStoryCommit(row);
}

export function recordStoryCommit(
	db: DatabaseSync,
	storyId: number,
	updates: { commit_sha?: string | null; backup_ref?: string | null },
): StoryCommit | null {
	const setClauses: string[] = [];
	const values: SqlValue[] = [];
	for (const [key, value] of Object.entries(updates)) {
		if (value === undefined) continue;
		setClauses.push(`${key} = ?`);
		values.push(value as SqlValue);
	}
	if (setClauses.length === 0) return getStoryCommit(db, storyId);

	values.push(storyId);
	const row = db
		.prepare(`UPDATE story_commits SET ${setClauses.join(", ")} WHERE story_id = ? RETURNING *`)
		.get(...values) as Record<string, unknown> | undefined;
	return row ? rowToStoryCommit(row) : null;
}

export function getStoryCommit(db: DatabaseSync, storyId: number): StoryCommit | null {
	const row = db.prepare("SELECT * FROM story_commits WHERE story_id = ?").get(storyId) as
		| Record<string, unknown>
		| undefined;
	return row ? rowToStoryCommit(row) : null;
}

export function getStoryCommitsForEpic(db: DatabaseSync, epicId: number): StoryCommit[] {
	const rows = db
		.prepare("SELECT * FROM story_commits WHERE epic_id = ? ORDER BY created_at ASC")
		.all(epicId) as Record<string, unknown>[];
	return rows.map(rowToStoryCommit);
}
