import type { DatabaseSync } from "node:sqlite";
import type { RelatedStoriesStrategy } from "./related.ts";

/**
 * Everything stateful the tracker touches, passed explicitly.
 *
 * Nothing in `src/` may import from `@earendil-works/*` — `extensions/index.ts`
 * is the only pi-aware file. That boundary is what lets the whole layer below
 * run under plain `node --test` against a temp repo, with no pi runtime.
 */

export interface GitResult {
	stdout: string;
	stderr: string;
	/** Non-zero is the only failure signal — runners never throw. */
	code: number;
}

export interface GitOptions {
	cwd?: string;
	timeout?: number;
}

/**
 * Runs `git` with an argv array (never a shell string, so nothing needs quoting).
 *
 * Implementations must resolve rather than reject on a failed command, matching
 * `pi.exec`'s contract: a missing binary or a non-zero exit both come back as
 * `code !== 0`.
 */
export interface GitRunner {
	(args: string[], opts?: GitOptions): Promise<GitResult>;
}

export interface TrackerPaths {
	/** Main repository working tree — git operations default here. */
	repoRoot: string;
	/** stories.db. Anchored to `repoRoot` so every worktree shares one database. */
	dbPath: string;
	/** Parent directory for epic worktrees. Deliberately outside `repoRoot`. */
	worktreeRoot: string;
	/** `.pi/epic.json`, the declared setup manifest. */
	manifestPath: string;
}

export type NotifyLevel = "info" | "warning" | "error";

export interface TrackerContext {
	paths: TrackerPaths;
	db: DatabaseSync;
	git: GitRunner;
	/** How "related stories" and "lessons" are chosen. Swappable for embeddings. */
	related: RelatedStoriesStrategy;
	/** Injectable so tests get deterministic timestamps. */
	now: () => number;
	/** Wired to `ctx.ui.notify` in the extension; a no-op in tests. */
	notify: (message: string, level: NotifyLevel) => void;
}
