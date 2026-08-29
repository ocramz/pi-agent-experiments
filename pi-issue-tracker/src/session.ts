/**
 * One session's mutable state, and the operations that read or advance it.
 *
 * `TrackerContext` is the *injected dependencies* — paths, database handle, git
 * and shell runners, clock, notifier. It is built once at `session_start` and
 * everything in `src/` takes it. What it deliberately does not carry is anything
 * that changes as the session runs, and until now that state lived as seven
 * module-level `let`s in `extensions/index.ts`, which is why every function that
 * touched it had to live there too.
 *
 * `TrackerSession` extends rather than replaces it. By structural typing every
 * existing function that takes a `TrackerContext` accepts a `TrackerSession`
 * unchanged, so `epic.ts`, `git.ts` and `worktree.ts` — and their tests — are
 * untouched; only the session-scoped operations below demand the superset.
 *
 * The singleton holding one of these stays in `extensions/`, not here. A
 * module-level session in `src/` would be a global shared by every test in one
 * `node --test` process, which is the bug `openDb` was fixed for.
 */

import type { ReviewerChoice } from "./config.ts";
import type { TrackerContext } from "./context.ts";
import { getEpicBranch } from "./database.ts";
import { resolveSessionEpic } from "./epic.ts";
import type { EpicBranch } from "./types.ts";
import { emptyUsage, type TokenUsage } from "./usage.ts";

export interface TrackerSession extends TrackerContext {
	/**
	 * The epic *this session* is working on, resolved from where it stands.
	 *
	 * There is no such thing as "the" active epic: worktree mode runs several at
	 * once, each in its own directory with its own pi session. A hook asking "am
	 * I in an epic?" means its own, so every session-scoped lookup goes through
	 * here rather than through the database's global view.
	 *
	 * Only the id is cached. The row is re-read on every use, so a state change
	 * made by this session or another one is seen immediately.
	 */
	epicId: number | null;

	/**
	 * Git work is serialized through this chain.
	 *
	 * Two transitions in flight at once — an agent tool call while the story
	 * board is open, say — would race on `.git/index.lock` and one would fail for
	 * no reason the user could act on. This orders *this process* only;
	 * `withLockRetry` in src/git.ts is what mitigates concurrent worktree
	 * sessions.
	 */
	gitQueue: Promise<unknown>;

	/**
	 * Notes produced by git side effects, waiting to be folded into whatever tool
	 * response or command output comes next. A transition is triggered from
	 * several places, so the note cannot simply be a return value.
	 */
	gitNotes: string[];

	/**
	 * Which model reviews stories, or null for self-review.
	 *
	 * Only the *choice* is held. The runner that uses it is built from whichever
	 * live pi context is calling, because `ctx.modelRegistry` belongs to one
	 * context and a session outlives several — see src/context.ts.
	 */
	reviewer: ReviewerChoice | null;

	/**
	 * Reviewer tokens, accumulated across the session.
	 *
	 * A tool's model calls have the same blind spot `/plan-stories` documents:
	 * they never become session entries, so pi's footer counter cannot see them.
	 */
	reviewUsage: TokenUsage;

	/**
	 * Start a new agent turn with this text.
	 *
	 * Injected for the same reason `notify` is: the real implementation is
	 * `pi.sendUserMessage`, which `src/` may not import. Defaults to a no-op, so
	 * a test gets a session it can drive without stubbing anything.
	 */
	sendToAgent: (text: string) => void;
}

export function createSession(
	ctx: TrackerContext,
	opts: { sendToAgent?: (text: string) => void } = {},
): TrackerSession {
	return {
		...ctx,
		epicId: null,
		gitQueue: Promise.resolve(),
		gitNotes: [],
		reviewer: null,
		reviewUsage: emptyUsage(),
		sendToAgent: opts.sendToAgent ?? (() => {}),
	};
}

/** Run `work` after everything already queued, whether that succeeded or not. */
export function serializeGit<T>(session: TrackerSession, work: () => Promise<T>): Promise<T> {
	const next = session.gitQueue.then(work, work);
	session.gitQueue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

export function pushGitNote(session: TrackerSession, note: string): void {
	session.gitNotes.push(note);
}

/** Drain the pending notes into a suffix for the next response. Empty when there are none. */
export function takeGitNotes(session: TrackerSession): string {
	if (session.gitNotes.length === 0) return "";
	const combined = `\n\n${session.gitNotes.join("\n")}`;
	session.gitNotes = [];
	return combined;
}

/**
 * This session's epic, re-read, or null if it has none or its epic has ended.
 *
 * The `state === "active"` check is what makes a cancelled or merged epic stop
 * counting the moment another session ends it, without this one being told.
 */
export function sessionEpic(session: TrackerSession): EpicBranch | null {
	if (session.epicId === null) return null;
	const epic = getEpicBranch(session.db, session.epicId);
	return epic && epic.state === "active" ? epic : null;
}

/** Re-resolve which epic this session owns from the directory it is standing in. */
export async function refreshSessionEpic(session: TrackerSession, cwd: string): Promise<EpicBranch | null> {
	const epic = await resolveSessionEpic(session, cwd);
	session.epicId = epic?.epic_id ?? null;
	return epic;
}
