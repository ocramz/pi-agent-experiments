/**
 * The extension's own runtime: the session singleton, the pi-backed runners
 * built around it, and the handful of helpers that need a live pi context.
 *
 * Everything here is pi-coupled by necessity — `pi.exec`, `ctx.modelRegistry`,
 * `SessionManager.forkFrom`, `ctx.ui.setStatus`. Anything that is not lives in
 * `src/`, where `node --test` can reach it.
 *
 * `index.ts` declares; this file is what its handlers call.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { describeReviewerConfig, resolvePaths, resolveReviewer } from "../src/config.ts";
import type { GitRunner, NotifyLevel, ReviewerRunner, ShellRunner } from "../src/context.ts";
import { closeDb, missingStoryColumns, openDb } from "../src/database.ts";
import { ensureDatabaseIgnored } from "../src/epic.ts";
import { probeRepo, withLockRetry, type RepoInfo } from "../src/git.ts";
import { keywordStrategy } from "../src/related.ts";
import {
	createSession,
	refreshSessionEpic as refreshSessionEpicOf,
	serializeGit as serializeGitOn,
	sessionEpic as sessionEpicOf,
	takeGitNotes as takeGitNotesFrom,
	type TrackerSession,
} from "../src/session.ts";
import { openStoryCount, transitionStatus as transitionStatusOn } from "../src/transitions.ts";
import type { EpicBranch, Story } from "../src/types.ts";
import { addUsage, formatUsage, hasUsage } from "../src/usage.ts";
import { reconcileWorktrees } from "../src/worktree.ts";

/**
 * The session, rebuilt on each `session_start`. Everything stateful hangs off it
 * — see src/session.ts for what it carries and why `src/` may not hold one.
 *
 * It is a module-level `let` on purpose, and must stay one. `finishMerge` runs
 * inside a `withSession` callback belonging to the *old* extension instance,
 * after `session_shutdown` has nulled this and the *new* instance's
 * `session_start` has rebuilt it. Reading it there works only because module
 * scope is shared across instances in one process; a per-invocation holder would
 * break worktree-mode `/merge-epic` silently. See src/README.md on `withSession`.
 */
let tracker: TrackerSession | null = null;
/** Repository state as of session start. Null before the first probe. */
let repo: RepoInfo | null = null;

/**
 * Why a session sometimes cannot follow its epic into the worktree.
 *
 * pi writes a session file only once the session contains an assistant message
 * — `SessionManager._persist` checks for one before flushing anything — and
 * slash commands produce no session entries at all. So a session that has only
 * run `/plan-stories` and `/start-epic` has never been written to disk, and
 * `forkFrom` has nothing to fork.
 *
 * Nothing is lost when this happens: the worktree exists and the epic is
 * recorded, so opening pi in that directory picks it up. Saying so is better
 * than inventing a session, which would silently discard whatever conversation
 * the user did have.
 */
export const NOTHING_TO_RELOCATE =
	"this session has not been saved yet (pi writes a session file after the first model reply)";

/**
 * The context handed to a `withSession` callback after a session switch.
 *
 * pi names this `ReplacedSessionContext` but does not re-export it from the
 * package root, so it is recovered from the one signature that does mention it
 * rather than reached for through `dist/`. It is an `ExtensionCommandContext`
 * plus `sendMessage`/`sendUserMessage`.
 */
export type ReplacedSession = Parameters<
	NonNullable<NonNullable<Parameters<ExtensionCommandContext["switchSession"]>[1]>["withSession"]>
>[0];

/**
 * Tell the user what happened, through a channel that survives where it is said.
 *
 * A `ui.notify` posted while pi is rebuilding the TUI around a replacement
 * session is simply lost: the repaint draws the new session's transcript and the
 * notification was never part of it. Everything worth saying after a relocation
 * — the epic started, the merge landed, the worktree is gone — is therefore sent
 * as a displayed message, which *is* part of the transcript.
 *
 * Outside a relocation there is no repaint to lose it to, and `notify` is the
 * right, familiar affordance.
 */
export async function report(
	ctx: ExtensionCommandContext | ReplacedSession,
	text: string,
	level: NotifyLevel = "info",
): Promise<void> {
	const replacement = ctx as Partial<ReplacedSession>;
	if (typeof replacement.sendMessage === "function") {
		// Failures matter more here than successes, not less: a merge that did not
		// happen must not be the thing the repaint swallows.
		const prefix = level === "error" ? "Error: " : level === "warning" ? "Warning: " : "";
		await replacement.sendMessage({ customType: "epic-worktree", content: `${prefix}${text}`, display: true });
		return;
	}
	ctx.ui.notify(text, level);
}

/** This session's epic, or null before a session starts. See src/session.ts. */
export function sessionEpic(): EpicBranch | null {
	return tracker ? sessionEpicOf(tracker) : null;
}

export async function refreshSessionEpic(cwd: string): Promise<EpicBranch | null> {
	return tracker ? refreshSessionEpicOf(tracker, cwd) : null;
}

export function serializeGit<T>(work: () => Promise<T>): Promise<T> {
	return serializeGitOn(ensureTracker(), work);
}

export function takeGitNotes(): string {
	return tracker ? takeGitNotesFrom(tracker) : "";
}

/** The session, or null before one starts. Prefer `ensureTracker` where a session is required. */
export function maybeTracker(): TrackerSession | null {
	return tracker;
}

/** What `probeRepo` found at session start, or null before the first probe. */
export function repoInfo(): RepoInfo | null {
	return repo;
}

// ─── Helpers ────────────────────────────────────────────────────────
export function ensureTracker(): TrackerSession {
	if (!tracker) throw new Error("Tracker not initialized (session not started)");
	return tracker;
}

export function ensureDb() {
	return ensureTracker().db;
}

/** A `GitRunner` backed by the host's sanctioned exec. Never throws; see src/context.ts. */
export function createExecGitRunner(pi: ExtensionAPI): GitRunner {
	return async (args, opts) => {
		const result = await pi.exec("git", args, { cwd: opts?.cwd, timeout: opts?.timeout });
		return { stdout: result.stdout, stderr: result.stderr, code: result.code };
	};
}

/** A `ShellRunner` over the host's exec. The manifest's commands need a shell. */
export function createExecShellRunner(pi: ExtensionAPI): ShellRunner {
	return async (command, opts) => {
		const result = await pi.exec("bash", ["-c", command], { cwd: opts?.cwd, timeout: opts?.timeout });
		return { stdout: result.stdout, stderr: result.stderr, code: result.code };
	};
}

export function isDbReady() {
	try {
		ensureDb();
		return true;
	} catch {
		return false;
	}
}

/**
 * The slice of an extension context that module-scope helpers need.
 *
 * Structural rather than pi's own `ExtensionContext`, so these helpers stay
 * callable from a test with a two-field stub.
 */
export type UiContext = {
	hasUI: boolean;
	ui: {
		setStatus(key: string, text: string | undefined): void;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
};

/** Keep the footer's open-story count honest after stories change. */
export function refreshStatus(ctx: UiContext) {
	if (!ctx.hasUI || !isDbReady()) return;
	const open = openStoryCount(ensureDb());
	ctx.ui.setStatus("issue-tracker", open > 0 ? `${open} open story(ies)` : undefined);
}

/** The single write path for `status`. See src/transitions.ts. */
export async function transitionStatus(
	storyId: number,
	updates: Partial<Omit<Story, "id" | "created_at" | "updated_at">>,
): Promise<Story | null> {
	return transitionStatusOn(ensureTracker(), storyId, updates);
}

// ─── Review ─────────────────────────────────────────────────────────

/**
 * Build a reviewer from the context that is calling, or null for self-review.
 *
 * `ctx.modelRegistry` is reachable from a *tool*, not only a command — which is
 * the whole reason an independent reviewer can run without breaking the agent's
 * autonomy. `ToolDefinition.execute` receives an `ExtensionContext`, and that
 * carries the registry.
 *
 * Built per call rather than cached on the tracker: the registry belongs to one
 * live context, and the tracker outlives several.
 */
export function buildReviewer(ctx: ExtensionContext): ReviewerRunner | null {
	const choice = ensureTracker().reviewer;
	if (!choice) return null;

	const registry = ctx.modelRegistry;
	const model = registry.find(choice.provider, choice.modelId);
	if (!model) return null;

	return async (req, signal) => {
		try {
			const response = await registry.complete(
				model,
				{
					systemPrompt: req.systemPrompt,
					messages: [
						{ role: "user" as const, content: [{ type: "text" as const, text: req.prompt }], timestamp: Date.now() },
					],
				},
				{ sessionId: reviewSessionId, signal },
			);
			// Aborted and truncated replies still burn tokens, so bank usage before
			// deciding whether the text is usable.
			addUsage(ensureTracker().reviewUsage, response.usage);
			if (response.stopReason === "aborted") return { ok: false, error: "the review was aborted" };
			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();
			if (response.stopReason === "length") {
				return { ok: false, error: "the reviewer hit its output limit before finishing" };
			}
			return { ok: true, text, model: `${choice.provider}/${choice.modelId}`, usage: response.usage };
		} catch (err) {
			// The runner contract is resolve-never-throw, matching GitRunner.
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	};
}

/** One id for every review call in this session, as `/plan-stories` does for planning. */
export const reviewSessionId = randomUUID();

export function reportReviewUsage(ctx: UiContext): void {
	const tracked = tracker;
	if (!tracked || !hasUsage(tracked.reviewUsage)) return;
	const label = tracked.reviewer ? `review ${tracked.reviewer.modelId}` : "review";
	ctx.ui.setStatus("issue-tracker-review", `${label} ${formatUsage(tracked.reviewUsage)}`);
}

// ─── Session lifecycle ──────────────────────────────────────────────
/**
 * Build the session from where pi is standing. The `session_start` handler's
 * whole body — it is wiring, but it is 100 lines of it.
 */
export async function startSession(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	// SessionStartEvent carries no cwd — the session's cwd is on the context.
	// Reading it off the event silently resolved to undefined every time.
	const cwd = ctx.cwd ?? process.cwd();
	// Wrapped, because concurrent worktree epics mean concurrent pi processes
	// on one repository and `serializeGit` only orders this one. See src/git.ts.
	const git = withLockRetry(createExecGitRunner(pi));

	// Paths come from the *common* git dir, so a linked worktree resolves to
	// the main checkout's stories.db rather than opening an empty one of its
	// own and losing the epic. See src/config.ts.
	const paths = await resolvePaths({ cwd, git });
	repo = await probeRepo(git, cwd);

	closeDb(tracker?.db ?? null);
	tracker = createSession(
		{
			paths,
			db: openDb(paths.dbPath),
			git,
			shell: createExecShellRunner(pi),
			related: keywordStrategy,
			now: () => Date.now(),
			notify: (message, level) => {
				if (ctx.hasUI) ctx.ui.notify(message, level);
			},
		},
		{ sendToAgent: (text) => void pi.sendUserMessage(text, { deliverAs: "followUp" }) },
	);

	// There are no migrations: INIT_SQL is all CREATE TABLE IF NOT EXISTS, so a
	// database written before the review columns existed keeps its old shape
	// and every read of them throws. Say so once, with the fix, instead of
	// failing cryptically on every turn.
	const stale = missingStoryColumns(tracker.db);
	if (stale.length > 0 && ctx.hasUI) {
		ctx.ui.notify(
			`${paths.dbPath} predates the ${stale.join(" and ")} column(s) and cannot be read. ` +
				`This extension has no migrations — delete the file and re-plan.`,
			"error",
		);
	}

	tracker.reviewer = resolveReviewer({ repoRoot: paths.repoRoot });
	const reviewerConfig = describeReviewerConfig({ repoRoot: paths.repoRoot });
	if (!reviewerConfig.ok && ctx.hasUI) {
		// A half-configured reviewer must not quietly become self-review: the
		// user asked for an independent one and would never find out.
		ctx.ui.notify(`Reviewer not configured: ${reviewerConfig.reason}. Falling back to self-review.`, "warning");
	} else if (tracker.reviewer) {
		const model = ctx.modelRegistry.find(tracker.reviewer.provider, tracker.reviewer.modelId);
		if (!model) {
			ctx.ui.notify(
				`Reviewer ${tracker.reviewer.provider}/${tracker.reviewer.modelId} is not a known model — falling back to self-review.`,
				"warning",
			);
			tracker.reviewer = null;
		} else if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			// Caught here rather than mid-loop: the first story to be reviewed
			// is a bad place to discover a missing API key.
			ctx.ui.notify(
				`Reviewer ${tracker.reviewer.provider}/${tracker.reviewer.modelId} has no configured credentials — falling back to self-review.`,
				"warning",
			);
			tracker.reviewer = null;
		} else {
			ctx.ui.setStatus("issue-tracker-review", `reviewer ${tracker.reviewer.modelId}`);
		}
	}

	// The extension creates stories.db, so it takes responsibility for keeping
	// it out of the user's `git status` — whether or not an epic is ever
	// started. Idempotent, so running it every session costs one check-ignore.
	if (repo.isRepo) await ensureDatabaseIgnored(tracker);

	if (repo.isRepo) {
		await reportReconciliation(ctx);
		// Which epic this session owns depends on where it is standing, so it
		// can only be answered once the paths are resolved.
		await refreshSessionEpic(cwd);
	}

	// session_start cannot be cancelled, so an unusable repo is reported
	// rather than enforced here; /start-epic is the gate.
	if (!repo.isRepo && ctx.hasUI) {
		ctx.ui.setStatus("issue-tracker-git", "not a git repository");
	}
	refreshStatus(ctx);
}

/** Report what `reconcileWorktrees` found; see src/worktree.ts for why only one half is acted on. */
async function reportReconciliation(ctx: UiContext): Promise<void> {
	const tracked = tracker;
	if (!tracked) return;
	const { cancelled, orphaned } = await reconcileWorktrees(tracked);
	if (!ctx.hasUI) return;

	for (const epic of cancelled) {
		ctx.ui.notify(
			`Epic #${epic.epic_id}'s worktree is gone — marked cancelled. Its work is still on ${epic.branch}.`,
			"warning",
		);
	}
	if (orphaned.length > 0) {
		const paths = orphaned.map((entry) => entry.path).join(", ");
		ctx.ui.notify(
			`${orphaned.length} epic worktree(s) no longer belong to an active epic: ${paths}. ` +
				`Remove with: git worktree remove <path>`,
			"info",
		);
	}
}

/** Drop the session and everything on it. */
export function endSession(): void {
	closeDb(tracker?.db ?? null);
	// Dropping the session drops the epic id, the git queue and its pending
	// notes, the reviewer choice and its token total along with it.
	tracker = null;
	repo = null;
}
