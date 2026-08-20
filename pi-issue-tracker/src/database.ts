import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Story, type StoryHistoryEntry } from "./types.ts";

let db: DatabaseSync | null = null;

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
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);
CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(status);
CREATE INDEX IF NOT EXISTS idx_stories_priority ON stories(priority);

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
`;

export function getDb(dbPath: string): DatabaseSync {
	if (!db) {
		mkdirSync(dirname(dbPath), { recursive: true });
		db = new DatabaseSync(dbPath);
		db.exec(INIT_SQL);
	}
	return db;
}

export function closeDb(): void {
	if (db) {
		db.close();
		db = null;
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
		created_at: row.created_at as number,
		updated_at: row.updated_at as number,
	};
}

export function createStory(
	db: DatabaseSync,
	data: Omit<Story, "id" | "created_at" | "updated_at">,
): Story {
	const stmt = db.prepare(
		`INSERT INTO stories (title, sub_goal, proposed_changes, status, priority, parent_id, next_id, depends_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
	) as Record<string, unknown>;

	const story = rowToStory(row);
	logHistory(db, story.id, "create", null, JSON.stringify(story));
	return story;
}

export function updateStory(db: DatabaseSync, id: number, updates: Partial<Omit<Story, "id" | "created_at" | "updated_at">>): Story | null {
	const existing = getStoryById(db, id);
	if (!existing) return null;

	const setClauses: string[] = [];
	const values: unknown[] = [];

	for (const [key, value] of Object.entries(updates)) {
		if (key === "depends_on") {
			setClauses.push(`${key} = ?`);
			values.push(JSON.stringify(value));
		} else if (value !== undefined) {
			setClauses.push(`${key} = ?`);
			values.push(value);
		}
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
