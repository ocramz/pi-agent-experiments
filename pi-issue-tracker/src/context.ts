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

/**
 * Runs a shell command string — the setup and verify commands declared in
 * `.pi/epic.json`, which are authored by the user and need a shell.
 *
 * Same contract as `GitRunner`: resolves with a non-zero `code` rather than
 * throwing. `env` is merged over the ambient environment, which is how the
 * manifest's `caches` entries get pointed at a shared directory.
 */
export interface ShellRunner {
	(command: string, opts?: GitOptions & { env?: Record<string, string> }): Promise<GitResult>;
}

/** What a reviewer model was asked, and what it cost. */
export interface ReviewRequest {
	systemPrompt: string;
	prompt: string;
}

export interface ReviewUsage {
	input?: number;
	output?: number;
}

export type ReviewReply =
	| { ok: true; text: string; model: string; usage?: ReviewUsage }
	| { ok: false; error: string };

/**
 * Calls a second model to review a story.
 *
 * Same contract as `GitRunner` and `ShellRunner`: resolves with `ok: false`
 * rather than throwing, so a flaky reviewer is an outcome the caller handles
 * rather than an exception that unwinds a tool call.
 *
 * Injected because `src/` may not import from `@earendil-works/*` — the real
 * implementation is built in `extensions/index.ts` from `ctx.modelRegistry`,
 * and tests pass a stub. Null means no independent reviewer is configured, in
 * which case the working agent supplies its own verdict.
 *
 * Deliberately *not* a field on `TrackerContext`. `ctx.modelRegistry` belongs to
 * one live pi context, and a tracker built at `session_start` outlives several;
 * both callers build a runner from the context they were handed, so there is
 * nothing stale to capture. See src/README.md on `withSession` closures for the
 * bug class this avoids.
 */
export interface ReviewerRunner {
	(req: ReviewRequest, signal?: AbortSignal): Promise<ReviewReply>;
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
	shell: ShellRunner;
	/** How "related stories" and "lessons" are chosen. Swappable for embeddings. */
	related: RelatedStoriesStrategy;
	/** Injectable so tests get deterministic timestamps. */
	now: () => number;
	/** Wired to `ctx.ui.notify` in the extension; a no-op in tests. */
	notify: (message: string, level: NotifyLevel) => void;
}
