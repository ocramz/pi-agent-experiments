// What a case asserts on after the pi session ends.
//
// The manual suite reached the fixture through two shell helpers — `git_in` and
// a `db_query` that took raw SQL. Both are replaced here by the package's own
// accessors, so a schema change breaks the tests at the type level instead of
// silently returning an empty string.
//
// Everything is read-only and opened per call: the pi session under test holds
// the database in WAL mode, and these run after it has exited.

import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { GitRunner } from "../../src/context.ts";
import { closeDb, openDb } from "../../src/database.ts";
import { createLocalGitRunner } from "../../src/git.ts";
import { fixtureEnv } from "./fixtures.ts";

export interface Inspector {
	/** `git <args>` in the fixture, trimmed stdout. Empty string on failure. */
	git(...args: string[]): Promise<string>;
	/** Open the tracker database, hand it to `fn`, and always close it. */
	db<T>(fn: (db: DatabaseSync) => T): T;
	/** The checked-out branch, or "" on a detached HEAD or a non-repo. */
	branch(): Promise<string>;
	/** Commits reachable from a ref. */
	count(ref?: string): Promise<number>;
	/** Refs under a `refs/pi/...` prefix. */
	piRefs(prefix: string): Promise<string[]>;
	/** A path inside the fixture. */
	path(relative: string): string;
	exists(relative: string): boolean;
	read(relative: string): string;
}

export function inspector(dir: string): Inspector {
	const runner: GitRunner = createLocalGitRunner({ cwd: dir, env: fixtureEnv(dir) });

	const git = async (...args: string[]): Promise<string> => {
		// safe.directory because a fixture built by one uid and read by another
		// (the container's bind mount) would otherwise be refused outright.
		const result = await runner(["-c", `safe.directory=${dir}`, ...args]);
		return result.code === 0 ? result.stdout.trim() : "";
	};

	return {
		git,
		db<T>(fn: (db: DatabaseSync) => T): T {
			const handle = openDb(join(dir, ".pi", "stories.db"));
			try {
				return fn(handle);
			} finally {
				closeDb(handle);
			}
		},
		branch: () => git("branch", "--show-current"),
		async count(ref = "HEAD") {
			return Number((await git("rev-list", "--count", ref)) || "0");
		},
		async piRefs(prefix) {
			const out = await git("for-each-ref", "--format=%(refname)", `refs/pi/${prefix}`);
			return out ? out.split("\n") : [];
		},
		path: (relative) => join(dir, relative),
		exists: (relative) => existsSync(join(dir, relative)),
		read: (relative) => readFileSync(join(dir, relative), "utf8"),
	};
}

/** `select count(*) from <table>` — for the rows with no typed accessor. */
export function rowCount(db: DatabaseSync, table: "epic_branches" | "story_commits" | "stories"): number {
	const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
	return row.n;
}
