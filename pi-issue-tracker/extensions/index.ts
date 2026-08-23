import { StringEnum } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
	closeDb,
	createStory,
	deleteStories,
	getAllStories,
	getAppState,
	getChildren,
	getMaxPriority,
	getStoriesByStatus,
	getStoryById,
	getActiveBranchModeEpic,
	getActiveEpicBranches,
	getEpicBranch,
	getLastMergedEpicBranch,
	hasChildren,
	openDb,
	searchStories,
	setAppState,
	transaction,
	updateEpicBranch,
	updateStory,
	wouldCreateCycle,
} from "../src/database.ts";
import type { Story } from "../src/types.ts";
import { STORY_RESOLUTIONS } from "../src/types.ts";
import { keywordStrategy } from "../src/related.ts";
import { resolvePaths } from "../src/config.ts";
import type { GitRunner, ShellRunner, TrackerContext } from "../src/context.ts";
import { currentBranch, isDirty, probeRepo, revParse, withLockRetry, type RepoInfo } from "../src/git.ts";
import {
	cancelEpic,
	commitStory,
	ensureDatabaseIgnored,
	epicCwd,
	epicWorktreePath,
	findEpicForStory,
	mergeIntoBase,
	pruneCheckpoints,
	pruneEpicRefs,
	recordStoryStartCommit,
	releaseWorktree,
	resolveSessionEpic,
	startEpic,
	undoMerge,
	undoStory,
	updateFromBase,
} from "../src/epic.ts";
import {
	checkCanMerge,
	checkCanStartEpic,
	checkpointRefPrefix,
	epicBranchName,
	isBranchEscapingCommand,
} from "../src/rules.ts";
import type { EpicBranch, EpicMode } from "../src/types.ts";
import { branchCheckoutLocation, findMissingWorktrees, listWorktrees } from "../src/worktree.ts";

// ─── State ──────────────────────────────────────────────────────────
/**
 * Everything stateful lives on one context, rebuilt on each `session_start`.
 * `src/` never reaches for a module-level singleton, which is what lets it be
 * tested against a temp repo with no pi runtime — see src/context.ts.
 */
let tracker: TrackerContext | null = null;
/** Repository state as of session start. Null before the first probe. */
let repo: RepoInfo | null = null;
/** Set once at registration, so module-scope helpers can talk back to the agent. */
let host: ExtensionAPI | null = null;

/**
 * The epic *this session* is working on, resolved from where the session stands.
 *
 * There is no longer any such thing as "the" active epic: worktree mode runs
 * several at once, each in its own directory with its own pi session. A hook
 * asking "am I in an epic?" means its own, so every session-scoped lookup goes
 * through here rather than through the database's global view.
 *
 * Only the id is cached. The row itself is re-read on every use, so a state
 * change made by this session or another one is seen immediately.
 */
let sessionEpicId: number | null = null;

/**
 * How many per-turn checkpoints an epic keeps.
 *
 * `/undo-turn` only ever reads the newest, so this is purely about how far back
 * a user can reach by hand with `git stash apply`. Twenty is roughly a session's
 * worth and costs a kilobyte of refs.
 */
const CHECKPOINT_RETENTION = 20;

function sessionEpic(): EpicBranch | null {
	if (sessionEpicId === null || !tracker) return null;
	const epic = getEpicBranch(tracker.db, sessionEpicId);
	return epic && epic.state === "active" ? epic : null;
}

async function refreshSessionEpic(cwd: string): Promise<EpicBranch | null> {
	if (!tracker) return null;
	const epic = await resolveSessionEpic(tracker, cwd);
	sessionEpicId = epic?.epic_id ?? null;
	return epic;
}

/**
 * Git work is serialized.
 *
 * Two transitions in flight at once — an agent tool call while the story board
 * is open, say — would race on `.git/index.lock` and one would fail for no
 * reason the user could act on.
 */
let gitQueue: Promise<unknown> = Promise.resolve();
function serializeGit<T>(work: () => Promise<T>): Promise<T> {
	const next = gitQueue.then(work, work);
	gitQueue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

/**
 * Notes produced by git side effects, waiting to be folded into whatever tool
 * response or command output comes next. The transition itself is triggered
 * from several places, so the note cannot simply be a return value.
 */
let gitNotes: string[] = [];
function takeGitNotes(): string {
	if (gitNotes.length === 0) return "";
	const combined = `\n\n${gitNotes.join("\n")}`;
	gitNotes = [];
	return combined;
}

// ─── Helpers ────────────────────────────────────────────────────────
function ensureTracker(): TrackerContext {
	if (!tracker) throw new Error("Tracker not initialized (session not started)");
	return tracker;
}

function ensureDb() {
	return ensureTracker().db;
}

/** A `GitRunner` backed by the host's sanctioned exec. Never throws; see src/context.ts. */
function createExecGitRunner(pi: ExtensionAPI): GitRunner {
	return async (args, opts) => {
		const result = await pi.exec("git", args, { cwd: opts?.cwd, timeout: opts?.timeout });
		return { stdout: result.stdout, stderr: result.stderr, code: result.code };
	};
}

/** A `ShellRunner` over the host's exec. The manifest's commands need a shell. */
function createExecShellRunner(pi: ExtensionAPI): ShellRunner {
	return async (command, opts) => {
		const result = await pi.exec("bash", ["-c", command], { cwd: opts?.cwd, timeout: opts?.timeout });
		return { stdout: result.stdout, stderr: result.stderr, code: result.code };
	};
}

const CLOSED_STATUSES: Story["status"][] = ["done", "cancelled", "archived"];

function isOpen(story: Story): boolean {
	return !CLOSED_STATUSES.includes(story.status);
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function storyToText(story: Story, compact = true): string {
	const lines = [
		`#${story.id} [${story.status}] ${story.title}`,
	];
	if (!compact) {
		lines.push(`  Sub-goal: ${story.sub_goal}`);
		lines.push("  Proposed changes:");
		for (const line of story.proposed_changes.split("\n")) {
			lines.push(`    ${line}`);
		}
		if (story.parent_id) {
			lines.push(`  Parent: #${story.parent_id}`);
		}
		if (story.depends_on.length) {
			lines.push(`  Depends on: ${story.depends_on.join(", ")}`);
		}
		if (story.next_id) {
			lines.push(`  Next: #${story.next_id}`);
		}
		if (story.resolution) {
			lines.push(`  Resolution: ${story.resolution}${story.resolution_note ? ` — ${story.resolution_note}` : ""}`);
		}
		if (story.learnings) {
			lines.push(`  Learned: ${story.learnings}`);
		}
	} else {
		lines[0] += ` — ${truncate(story.sub_goal, 60)}`;
	}
	return lines.join("\n");
}

function isDbReady() {
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
type UiContext = {
	hasUI: boolean;
	ui: {
		setStatus(key: string, text: string | undefined): void;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
};

/** Keep the footer's open-story count honest after stories change. */
function refreshStatus(ctx: UiContext) {
	if (!ctx.hasUI || !isDbReady()) return;
	const open = getAllStories(ensureDb()).filter(isOpen).length;
	ctx.ui.setStatus("issue-tracker", open > 0 ? `${open} open story(ies)` : undefined);
}

/**
 * Git side effects of a status change.
 *
 * Does nothing at all unless the story belongs to an epic that has been started
 * with `/start-epic` — git integration is opt-in, and a tracker used without it
 * behaves exactly as it did before.
 */
async function applyTransitionEffects(
	ctx: TrackerContext,
	before: Story | null,
	after: Story,
): Promise<void> {
	const epic = findEpicForStory(ctx, after.id);
	if (!epic) return;

	const wasOpen = before ? isOpen(before) : true;
	const isEpicItself = after.id === epic.epic_id;

	// Starting work: remember where it began, so it can be undone later.
	if (after.status === "in_progress" && before?.status !== "in_progress") {
		await recordStoryStartCommit(ctx, after, epic);
	}

	// A unit of work closed: commit what it changed. Epics are containers and
	// never carry a commit of their own.
	if (wasOpen && !isOpen(after) && !isEpicItself && !hasChildren(ctx.db, after.id)) {
		const committed = await commitStory(ctx, after, epic);
		if (committed.note) gitNotes.push(committed.note);
	}

	// The epic itself closed. Bring the base branch in now, while the agent is
	// still here to resolve conflicts; the merge into the base branch is a
	// separate, user-confirmed step and never happens on the agent's say-so.
	if (isEpicItself && wasOpen && !isOpen(after)) {
		const updated = await updateFromBase(ctx, epic);
		gitNotes.push(updated.note);
		if (updated.ok) {
			gitNotes.push(`Epic #${epic.epic_id} is ready to merge — run /merge-epic ${epic.epic_id}.`);
		} else if (updated.conflicts.length > 0) {
			void host?.sendUserMessage(
				`Merging ${epic.base_branch} into ${epic.branch} left conflicts in:\n` +
					updated.conflicts.map((file) => `  - ${file}`).join("\n") +
					`\n\nResolve them, commit, then run /merge-epic ${epic.epic_id}.`,
				{ deliverAs: "followUp" },
			);
		}
	}
}

/**
 * The single write path for a story's status.
 *
 * Status used to be written from three unrelated places — the `mark_in_progress`
 * action, the ungated `update` action, and the board's key handler — so anything
 * that had to happen on a transition would have had to be repeated three times
 * and would still have been missed by the next new caller. Git side effects hang
 * off this function.
 *
 * Two callers deliberately bypass it — `simplify` and `/plan-stories` — because
 * both write status inside a SQLite transaction, which cannot stay open across a
 * git subprocess. Both are bookkeeping rather than work starting or finishing,
 * so neither has a git effect to miss. Each says so at the call site.
 */
async function transitionStatus(
	storyId: number,
	updates: Partial<Omit<Story, "id" | "created_at" | "updated_at">>,
	uiCtx?: UiContext,
): Promise<Story | null> {
	const ctx = ensureTracker();
	const before = getStoryById(ctx.db, storyId);
	const after = updateStory(ctx.db, storyId, updates);
	if (!after) return null;
	if (uiCtx) refreshStatus(uiCtx);

	try {
		await serializeGit(() => applyTransitionEffects(ctx, before, after));
	} catch (error) {
		// A git failure must not lose the status change that already succeeded.
		gitNotes.push(`git side effect failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return after;
}

// ─── Usage accounting ───────────────────────────────────────────────
// `/plan-stories` is a command, so its model calls never become session
// entries and the built-in footer counter cannot see them. We total them
// ourselves and render them onto footer line 3 via setStatus.

interface PlanUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function emptyUsage(): PlanUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(total: PlanUsage, u: Usage | undefined): void {
	if (!u) return;
	total.input += u.input ?? 0;
	total.output += u.output ?? 0;
	total.cacheRead += u.cacheRead ?? 0;
	total.cacheWrite += u.cacheWrite ?? 0;
	total.cost += u.cost?.total ?? 0;
}

function hasUsage(u: PlanUsage): boolean {
	return u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0;
}

/** Same thresholds as the built-in footer's formatTokens. */
function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/** Mirrors the footer's `↑ ↓ R W $` idiom so both lines read as one display. */
function formatUsage(u: PlanUsage): string {
	const parts: string[] = [];
	if (u.input) parts.push(`↑${formatTokens(u.input)}`);
	if (u.output) parts.push(`↓${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(3)}`);
	return parts.join(" ");
}

// ─── Plan parsing ───────────────────────────────────────────────────

interface PlanItem {
	title: string;
	sub_goal: string;
	proposed_changes: string;
	depends_on?: number[];
	parent_index?: number | null;
}

/** Tolerate code fences and prose around the array, despite the prompt asking for neither. */
function extractJsonArray(text: string): string {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = (fenced ? fenced[1] : text).trim();
	const start = body.indexOf("[");
	const end = body.lastIndexOf("]");
	return start !== -1 && end > start ? body.slice(start, end + 1) : body;
}

/**
 * JSON.parse guarantees nothing about shape. Without this, a well-formed but
 * wrong-shaped response reaches createStory and trips a NOT NULL constraint
 * partway through the insert loop.
 */
function coercePlanItems(parsed: unknown): PlanItem[] | null {
	if (!Array.isArray(parsed) || parsed.length === 0) return null;
	const items: PlanItem[] = [];
	for (const raw of parsed) {
		if (typeof raw !== "object" || raw === null) return null;
		const r = raw as Record<string, unknown>;
		if (typeof r.title !== "string" || !r.title.trim()) return null;
		if (typeof r.sub_goal !== "string" || !r.sub_goal.trim()) return null;
		items.push({
			title: r.title.trim(),
			sub_goal: r.sub_goal.trim(),
			proposed_changes: typeof r.proposed_changes === "string" ? r.proposed_changes : "",
			depends_on: Array.isArray(r.depends_on)
				? r.depends_on.filter((d): d is number => typeof d === "number")
				: [],
			parent_index: typeof r.parent_index === "number" ? r.parent_index : null,
		});
	}
	return items;
}

/**
 * Repair out-of-range references instead of discarding the whole plan.
 * A bad parent_index falls back to the goal epic; a bad dependency is dropped.
 */
function repairStoryGraph(items: PlanItem[]): { items: PlanItem[]; warnings: string[] } {
	const warnings: string[] = [];
	const repaired = items.map((item, i) => {
		let parentIndex = item.parent_index ?? null;
		if (parentIndex != null && (parentIndex >= i || parentIndex < 0)) {
			warnings.push(`"${truncate(item.title, 40)}" had parent_index ${parentIndex}; re-parented to the goal.`);
			parentIndex = null;
		}
		const dependsOn = (item.depends_on ?? []).filter((dep) => {
			if (dep >= i || dep < 0) {
				warnings.push(`"${truncate(item.title, 40)}" dropped out-of-range dependency ${dep}.`);
				return false;
			}
			return true;
		});
		return { ...item, parent_index: parentIndex, depends_on: dependsOn };
	});
	return { items: repaired, warnings };
}

/**
 * Close any ancestor epic whose children have all closed, walking upwards.
 * Mirrors the existing next_id auto-promote: finishing work should move the
 * board without a second round-trip.
 */
async function closeCompletedParents(db: DatabaseSync, fromStoryId: number): Promise<Story[]> {
	const closed: Story[] = [];
	const seen = new Set<number>();
	let cursor = getStoryById(db, fromStoryId)?.parent_id ?? null;

	while (cursor !== null && !seen.has(cursor)) {
		seen.add(cursor);
		const epic = getStoryById(db, cursor);
		if (!epic || !isOpen(epic)) break;
		const children = getChildren(db, epic.id);
		if (children.length === 0 || children.some(isOpen)) break;

		const updated = await transitionStatus(epic.id, {
			status: "done",
			resolution: "completed",
			resolution_note: `All ${children.length} child stories closed.`,
		});
		if (!updated) break;
		closed.push(updated);
		cursor = updated.parent_id;
	}
	return closed;
}

/**
 * Depth-first ordering, each epic followed by its children.
 * Guards against cycles — nothing in the tool path prevents A→B→A.
 */
function treeOrder(stories: Story[]): { story: Story; depth: number }[] {
	const ids = new Set(stories.map((s) => s.id));
	const byParent = new Map<number | null, Story[]>();
	for (const s of stories) {
		// A parent outside this set is treated as a root so nothing is dropped.
		const key = s.parent_id !== null && ids.has(s.parent_id) ? s.parent_id : null;
		const bucket = byParent.get(key);
		if (bucket) bucket.push(s);
		else byParent.set(key, [s]);
	}

	const out: { story: Story; depth: number }[] = [];
	const seen = new Set<number>();
	const walk = (parent: number | null, depth: number) => {
		for (const s of byParent.get(parent) ?? []) {
			if (seen.has(s.id)) continue;
			seen.add(s.id);
			out.push({ story: s, depth });
			walk(s.id, depth + 1);
		}
	};
	walk(null, 0);

	// Anything unreachable (i.e. inside a cycle) is appended flat.
	for (const s of stories) {
		if (!seen.has(s.id)) out.push({ story: s, depth: 0 });
	}
	return out;
}

// ─── Schema ─────────────────────────────────────────────────────────
const StoryParams = Type.Object({
	action: StringEnum(["create", "update", "delete", "list", "mark_done", "mark_in_progress", "reorder", "simplify", "get_next", "search", "set_top_level"] as const),

	title: Type.Optional(Type.String({ description: "Title (for create / update / simplify)" })),
	sub_goal: Type.Optional(Type.String({ description: "Sub-goal (for create / update)" })),
	proposed_changes: Type.Optional(Type.String({ description: "Proposed changes (for create / update)" })),
	story_id: Type.Optional(Type.Number({ description: "Target story ID" })),
	status: Type.Optional(StringEnum(["draft", "ready", "in_progress", "done", "cancelled", "archived"] as const)),
	depends_on: Type.Optional(Type.Array(Type.Number(), { description: "Dependency story IDs (for create / update)" })),
	next_story_id: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Next linked story ID (for create / update). Pass null to unlink." })),
	parent_story_id: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Parent story ID (for create / update). Pass null to detach from its parent." })),

	resolution: Type.Optional(
		StringEnum(STORY_RESOLUTIONS, {
			description:
				"Why the story closed (required for mark_done): completed = built as planned; superseded = replaced by other work; obsolete = no longer needed; wontfix = decided against; duplicate = already covered elsewhere.",
		}),
	),
	resolution_note: Type.Optional(Type.String({ description: "One line of detail on the resolution, e.g. 'Merged into #12'" })),
	learnings: Type.Optional(
		Type.String({
			description:
				"Only set this if something CONTRADICTED proposed_changes — an assumption that proved false, an API that behaved differently than expected, a hidden dependency. If the implementation matched the plan, omit this field. Most stories should have no learnings.",
		}),
	),

	status_filter: Type.Optional(StringEnum(["draft", "ready", "in_progress", "done", "cancelled", "archived"] as const)),
	query: Type.Optional(Type.String({ description: "Search query" })),
	ordered_ids: Type.Optional(Type.Array(Type.Number(), { description: "Ordered IDs for reorder" })),
	source_ids: Type.Optional(Type.Array(Type.Number(), { description: "Source IDs to merge via simplify" })),
	merged_title: Type.Optional(Type.String({ description: "Title for merged story (simplify)" })),
});

// ─── Extension ──────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	host = pi;

	// ── Session lifecycle ────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
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
		tracker = {
			paths,
			db: openDb(paths.dbPath),
			git,
			shell: createExecShellRunner(pi),
			related: keywordStrategy,
			now: () => Date.now(),
			notify: (message, level) => {
				if (ctx.hasUI) ctx.ui.notify(message, level);
			},
		};

		// The extension creates stories.db, so it takes responsibility for keeping
		// it out of the user's `git status` — whether or not an epic is ever
		// started. Idempotent, so running it every session costs one check-ignore.
		if (repo.isRepo) await ensureDatabaseIgnored(tracker);

		if (repo.isRepo) {
			await reconcileWorktrees(ctx);
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
	});

	/**
	 * Reconcile what the database believes about worktrees against what git says.
	 *
	 * A crashed session or a manual `rm -rf` leaves an active row pointing at a
	 * directory that is gone; a failed removal leaves a directory no epic claims.
	 * The first is bookkeeping and is fixed silently — the epic's branch and its
	 * backup refs are untouched, so nothing is lost by marking the row cancelled.
	 *
	 * The second is only reported. Deleting a directory is not a decision to make
	 * on the user's behalf during startup, and a blocking dialog here would stall
	 * every session behind a question most of them do not need to answer.
	 */
	async function reconcileWorktrees(ctx: UiContext): Promise<void> {
		const tracked = tracker;
		if (!tracked) return;

		const entries = await listWorktrees(tracked.git, tracked.paths.repoRoot);
		const { missing, orphaned } = findMissingWorktrees(
			getActiveEpicBranches(tracked.db),
			entries,
			tracked.paths.worktreeRoot,
		);

		for (const epic of missing) {
			updateEpicBranch(tracked.db, epic.epic_id, { state: "cancelled", path: null }, tracked.now());
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Epic #${epic.epic_id}'s worktree is gone — marked cancelled. Its work is still on ${epic.branch}.`,
					"warning",
				);
			}
		}

		if (orphaned.length > 0 && ctx.hasUI) {
			const paths = orphaned.map((entry) => entry.path).join(", ");
			ctx.ui.notify(
				`${orphaned.length} epic worktree(s) no longer belong to an active epic: ${paths}. ` +
					`Remove with: git worktree remove <path>`,
				"info",
			);
		}
	}

	pi.on("session_shutdown", async () => {
		closeDb(tracker?.db ?? null);
		tracker = null;
		repo = null;
		sessionEpicId = null;
	});

	// ── Context injection ─────────────────────────────────────────────
	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!isDbReady()) return;
		const db = ensureDb();

		const allOpen = getAllStories(db).filter(isOpen);

		// 1. Ready story to work on now (topological: all deps done, then by priority/id).
		//    Epics are containers, never units of work.
		const readyStories = getStoriesByStatus(db, "ready");
		const readyToWork = readyStories
			.filter((s) => !hasChildren(db, s.id))
			.filter((s) => s.depends_on.every((depId) => getStoryById(db, depId)?.status === "done"))
			.sort((a, b) => a.priority - b.priority || a.id - b.id)[0] ?? null;

		// 2. Top-level story (big picture)
		const topLevelIdRaw = getAppState(db, "top_level_story_id");
		const topLevelStory = topLevelIdRaw ? getStoryById(db, Number(topLevelIdRaw)) : null;

		// 3. Story just closed in previous turn
		const lastClosedIdRaw = getAppState(db, "last_closed_story_id");
		const justClosed = lastClosedIdRaw ? getStoryById(db, Number(lastClosedIdRaw)) : null;
		if (lastClosedIdRaw) {
			setAppState(db, "last_closed_story_id", "");
		}

		// 4. Other in-progress stories
		const inProgressStories = getStoriesByStatus(db, "in_progress").sort(
			(a, b) => a.priority - b.priority || a.id - b.id,
		);
		const primaryFocus = readyToWork ?? inProgressStories[0] ?? null;
		const otherInProgress = inProgressStories.filter((s) => s.id !== primaryFocus?.id);

		const hasAnythingToShow = primaryFocus || topLevelStory || justClosed || otherInProgress.length > 0 || allOpen.length > 0;
		if (!hasAnythingToShow) return;

		const lines: string[] = [">>> STORY CONTEXT"];

		const epicLine = (s: Story): string | null => {
			if (!s.parent_id) return null;
			const parent = getStoryById(db, s.parent_id);
			return parent ? `Part of: #${parent.id} ${parent.title}` : null;
		};

		if (readyToWork) {
			lines.push(`\n>>> NEXT UP — work on this now`);
			lines.push(`#${readyToWork.id}: ${readyToWork.title}`);
			const epic = epicLine(readyToWork);
			if (epic) lines.push(epic);
			lines.push(`Sub-goal: ${readyToWork.sub_goal}`);
			lines.push(`Changes: ${readyToWork.proposed_changes}`);
			if (readyToWork.depends_on.length) {
				lines.push(`Dependencies met: ${readyToWork.depends_on.map((id) => `#${id}`).join(", ")}`);
			}
		} else if (inProgressStories.length > 0) {
			const p = inProgressStories[0];
			lines.push(`\n>>> IN PROGRESS — continue working on this`);
			lines.push(`#${p.id}: ${p.title}`);
			const epic = epicLine(p);
			if (epic) lines.push(epic);
			lines.push(`Sub-goal: ${p.sub_goal}`);
			lines.push(`Changes: ${p.proposed_changes}`);
		} else {
			lines.push(`\n>>> NO ACTIVE WORK — no ready or in-progress stories`);
		}

		if (topLevelStory) {
			lines.push(`\n>>> BIG PICTURE`);
			lines.push(`#${topLevelStory.id}: ${topLevelStory.title}`);
			lines.push(`${topLevelStory.sub_goal}`);
		}

		if (justClosed) {
			lines.push(`\n>>> JUST COMPLETED (previous turn)`);
			lines.push(`#${justClosed.id}: ${justClosed.title}`);
		}

		if (otherInProgress.length > 0) {
			lines.push(`\n>>> ALSO IN PROGRESS`);
			const selection = otherInProgress.slice(0, 5);
			for (const s of selection) {
				lines.push(`  ▶ #${s.id}: ${s.title} — ${s.sub_goal.slice(0, 60)}${s.sub_goal.length > 60 ? "…" : ""}`);
			}
			if (otherInProgress.length > 5) {
				lines.push(`  ... ${otherInProgress.length - 5} more`);
			}
		}

		if (primaryFocus) {
			const related = ensureTracker().related.findRelated(db, primaryFocus, 5);
			if (related.length > 0) {
				lines.push(`\n>>> RELATED STORIES`);
				for (const s of related) {
					lines.push(`  ◇ #${s.id}: ${s.title} — ${truncate(s.sub_goal, 60)}`);
				}
			}

			// Things earlier work discovered that contradicted its plan. Capped and
			// relevance-filtered — this rides on every turn's context.
			const lessons = ensureTracker().related.findLearnings(db, primaryFocus, 3);
			if (lessons.length > 0) {
				lines.push(`\n>>> LESSONS FROM COMPLETED WORK — these contradicted an earlier plan; check they don't apply here`);
				for (const s of lessons) {
					lines.push(`  ⚠ #${s.id} ${s.title}: ${truncate(s.learnings ?? "", 200)}`);
				}
			}
		}

		const activeEpic = sessionEpic();
		if (activeEpic) {
			lines.push(`\n>>> EPIC BRANCH`);
			lines.push(`Working on ${activeEpic.branch} (started from ${activeEpic.base_branch}).`);
			if (activeEpic.mode === "worktree" && activeEpic.path) {
				// Worth stating: the agent is in a checkout of its own, and other
				// epics may be running in sibling directories it must not touch.
				lines.push(`This session is in a dedicated worktree at ${activeEpic.path}. Work only inside it.`);
			}
			lines.push(`Every story you close is committed automatically — do not commit by hand.`);
			lines.push(`Do not switch branches, reset --hard, or delete branches; that would strand the epic.`);
		}

		return {
			message: {
				customType: "story-context",
				content: lines.join("\n"),
				display: true,
			},
		};
	});

	// ── Story Tool ──────────────────────────────────────────────────
	pi.registerTool({
		name: "story",
		label: "Story",
		description:
			"Issue tracker for self-contained work chunks (user stories). Actions: create (title, sub_goal, proposed_changes, status, next_story_id, depends_on, parent_story_id), update (story_id + fields), delete (story_id), list (status_filter), search (query), mark_in_progress (story_id), mark_done (story_id + REQUIRED resolution, optional resolution_note and learnings), get_next (fetch top ready), reorder (ordered_ids), simplify (source_ids + merged_title), set_top_level (story_id). Stories form a tree: a story with children is an epic and is never handed out as work.",
		parameters: StoryParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const db = ensureDb();
			const { action } = params;

			// ── create ─────────────────────────────────────────────
			if (action === "create") {
				if (!params.title || !params.sub_goal) {
					return { content: [{ type: "text", text: "Error: title and sub_goal are required for create" }], details: { action, error: "missing fields" } };
				}
				if (typeof params.parent_story_id === "number") {
					const parent = getStoryById(db, params.parent_story_id);
					if (!parent) {
						return { content: [{ type: "text", text: `Error: parent story #${params.parent_story_id} not found` }], details: { action, error: "parent not found" } };
					}
				}
				const story = createStory(db, {
					title: params.title,
					sub_goal: params.sub_goal,
					proposed_changes: params.proposed_changes ?? "",
					status: params.status ?? "draft",
					priority: getMaxPriority(db) + 1,
					parent_id: params.parent_story_id ?? null,
					next_id: params.next_story_id ?? null,
					depends_on: params.depends_on ?? [],
				});
				refreshStatus(ctx);
				return {
					content: [{ type: "text", text: `Created story #${story.id}: ${story.title}\n\n${storyToText(story, false)}` }],
					details: { action, story },
				};
			}

			// ── update ─────────────────────────────────────────────
			if (action === "update") {
				if (!params.story_id) {
					return { content: [{ type: "text", text: "Error: story_id required for update" }], details: { action, error: "missing story_id" } };
				}
				// null is meaningful here (detach), so check for a number specifically.
				if (typeof params.parent_story_id === "number") {
					const parent = getStoryById(db, params.parent_story_id);
					if (!parent) {
						return { content: [{ type: "text", text: `Error: parent story #${params.parent_story_id} not found` }], details: { action, error: "parent not found" } };
					}
					if (params.parent_story_id === params.story_id) {
						return { content: [{ type: "text", text: "Error: a story cannot be its own parent" }], details: { action, error: "self parent" } };
					}
					if (wouldCreateCycle(db, params.story_id, params.parent_story_id)) {
						return { content: [{ type: "text", text: `Error: parenting #${params.story_id} to #${params.parent_story_id} would create a cycle` }], details: { action, error: "cycle" } };
					}
				}
				const story = await transitionStatus(params.story_id, {
					title: params.title,
					sub_goal: params.sub_goal,
					proposed_changes: params.proposed_changes,
					status: params.status,
					next_id: params.next_story_id,
					depends_on: params.depends_on,
					parent_id: params.parent_story_id,
					resolution: params.resolution,
					resolution_note: params.resolution_note,
					learnings: params.learnings,
				});
				if (!story) {
					return { content: [{ type: "text", text: `Story #${params.story_id} not found` }], details: { action, error: "not found" } };
				}
				refreshStatus(ctx);
				return {
					content: [{ type: "text", text: `Updated story #${story.id}:\n${storyToText(story, false)}${takeGitNotes()}` }],
					details: { action, story },
				};
			}

			// ── delete ─────────────────────────────────────────────
			if (action === "delete") {
				if (!params.story_id) {
					return { content: [{ type: "text", text: "Error: story_id required for delete" }], details: { action, error: "missing story_id" } };
				}
				const story = getStoryById(db, params.story_id);
				if (!story) {
					return { content: [{ type: "text", text: `Story #${params.story_id} not found` }], details: { action, error: "not found" } };
				}
				// Detach children rather than leaving them pointing at a deleted row.
				const orphans = getChildren(db, params.story_id);
				for (const child of orphans) {
					updateStory(db, child.id, { parent_id: story.parent_id });
				}
				deleteStories(db, [params.story_id]);
				refreshStatus(ctx);
				const reparented = orphans.length
					? `\nReparented ${orphans.length} child story(ies) to ${story.parent_id ? `#${story.parent_id}` : "top level"}.`
					: "";
				return {
					content: [{ type: "text", text: `Deleted story #${params.story_id}: ${story.title}${reparented}` }],
					details: { action, deleted: story, reparented: orphans.length },
				};
			}

			// ── mark_in_progress ───────────────────────────────────
			if (action === "mark_in_progress") {
				if (!params.story_id) {
					return { content: [{ type: "text", text: "Error: story_id required for mark_in_progress" }], details: { action, error: "missing story_id" } };
				}
				const story = getStoryById(db, params.story_id);
				if (!story) {
					return { content: [{ type: "text", text: `Story #${params.story_id} not found` }], details: { action, error: "not found" } };
				}
				if (hasChildren(db, story.id)) {
					const kids = getChildren(db, story.id).filter(isOpen);
					return {
						content: [{ type: "text", text: `Story #${story.id} is an epic, not a unit of work. Start one of its children instead: ${kids.map((s) => `#${s.id}`).join(", ") || "(none open)"}` }],
						details: { action, error: "is an epic" },
					};
				}
				// dependency check
				const unmet = story.depends_on.filter((id) => getStoryById(db, id)?.status !== "done");
				if (unmet.length > 0) {
					return {
						content: [{ type: "text", text: `Cannot start: dependencies not done — ${unmet.map((id) => `#${id}`).join(", ")}` }],
						details: { action, error: "unmet dependencies", unmet },
					};
				}
				const updated = await transitionStatus(params.story_id, { status: "in_progress" });
				if (!updated) {
					return { content: [{ type: "text", text: "Update failed unexpectedly" }], details: { action, error: "update failed" } };
				}
				refreshStatus(ctx);
				return {
					content: [{ type: "text", text: `✓ Story #${updated.id} is now IN PROGRESS\n${storyToText(updated, false)}${takeGitNotes()}` }],
					details: { action, story: updated },
				};
			}

			// ── list ──────────────────────────────────────────────
			if (action === "list") {
				const validStatuses = new Set<Story["status"]>(["draft", "ready", "in_progress", "done", "cancelled", "archived"]);
				const stories = params.status_filter && validStatuses.has(params.status_filter as Story["status"])
					? getStoriesByStatus(db, params.status_filter as Story["status"])
					: getAllStories(db);
				if (stories.length === 0) {
					return {
						content: [{ type: "text", text: "No stories found." }],
						details: { action, stories: [] },
					};
				}
				const text = stories.map((s) => storyToText(s, false)).join("\n\n");
				return {
					content: [{ type: "text", text }],
					details: { action, stories },
				};
			}

			// ── search ─────────────────────────────────────────────
			if (action === "search") {
				if (!params.query) {
					return { content: [{ type: "text", text: "Error: query required for search" }], details: { action, error: "missing query" } };
				}
				const stories = searchStories(db, params.query);
				const text = stories.length ? stories.map((s) => storyToText(s, false)).join("\n\n") : "No matches.";
				return {
					content: [{ type: "text", text }],
					details: { action, stories },
				};
			}

			// ── mark_done ──────────────────────────────────────────
			if (action === "mark_done") {
				if (!params.story_id) {
					return { content: [{ type: "text", text: "Error: story_id required for mark_done" }], details: { action, error: "missing story_id" } };
				}
				const story = getStoryById(db, params.story_id);
				if (!story) {
					return { content: [{ type: "text", text: `Story #${params.story_id} not found` }], details: { action, error: "not found" } };
				}
				// Resolution gate — same shape as the dependency gate below. Optional
				// fields get skipped by models, and an unrecorded outcome is the whole
				// gap this closes, so require it explicitly.
				if (!params.resolution) {
					return {
						content: [{
							type: "text",
							text:
								`Cannot mark done: resolution required.\n` +
								`Pass resolution (${STORY_RESOLUTIONS.join("|")}) and optionally resolution_note.\n` +
								`Set learnings ONLY if something contradicted the proposed_changes for this story — ` +
								`an assumption that proved false, an API that behaved differently, a hidden dependency. ` +
								`If the work matched the plan, omit learnings.`,
						}],
						details: { action, error: "resolution required" },
					};
				}
				// dependency check
				const unmet = story.depends_on.filter((id) => getStoryById(db, id)?.status !== "done");
				if (unmet.length > 0) {
					return {
						content: [{ type: "text", text: `Cannot mark done: dependencies not done — ${unmet.map((id) => `#${id}`).join(", ")}` }],
						details: { action, error: "unmet dependencies", unmet },
					};
				}
				const openKids = getChildren(db, story.id).filter(isOpen);
				if (openKids.length > 0) {
					return {
						content: [{ type: "text", text: `Cannot mark done: epic #${story.id} still has open children — ${openKids.map((s) => `#${s.id}`).join(", ")}. They close it automatically when they are all done.` }],
						details: { action, error: "open children", open: openKids.map((s) => s.id) },
					};
				}
				const updated = await transitionStatus(params.story_id, {
					status: "done",
					resolution: params.resolution,
					resolution_note: params.resolution_note,
					learnings: params.learnings,
				});
				if (!updated) {
					return { content: [{ type: "text", text: "Update failed unexpectedly" }], details: { action, error: "update failed" } };
				}
				setAppState(db, "last_closed_story_id", String(updated.id));

				// Promote next if ready and dependencies met
				let nextMsg = "";
				if (updated.next_id) {
					const next = getStoryById(db, updated.next_id);
					if (next && next.status !== "done" && next.status !== "cancelled") {
						const nextUnmet = next.depends_on.filter((id) => getStoryById(db, id)?.status !== "done");
						if (nextUnmet.length === 0 && next.status !== "in_progress") {
							await transitionStatus(next.id, { status: "ready" });
							nextMsg = `\n\n>>> NEXT UP: Story #${next.id} is now READY.\nTitle: ${next.title}\nSub-goal: ${next.sub_goal}\nProposed changes: ${next.proposed_changes}`;
						} else if (nextUnmet.length > 0) {
							nextMsg = `\n\nNext story #${next.id} (${next.title}) is still waiting on dependencies: ${nextUnmet.map((id) => `#${id}`).join(", ")}`;
						}
					}
				}

				// Close any ancestor epic this completed
				const closedParents = await closeCompletedParents(db, updated.id);
				const epicMsg = closedParents.length
					? `\n\n>>> EPIC COMPLETE: ${closedParents.map((s) => `#${s.id} ${s.title}`).join(", ")}`
					: "";

				refreshStatus(ctx);
				return {
					content: [{ type: "text", text: `✓ Story #${updated.id} marked as DONE (${updated.resolution}).${epicMsg}${nextMsg}${takeGitNotes()}` }],
					details: { action, story: updated, nextMessage: nextMsg, closedEpics: closedParents },
				};
			}

			// ── get_next ──────────────────────────────────────────
			if (action === "get_next") {
				const ready = getStoriesByStatus(db, "ready");
				const topReady = ready
					.filter((s) => !hasChildren(db, s.id))
					.find((s) => s.depends_on.every((id) => getStoryById(db, id)?.status === "done"));
				if (!topReady) {
					return {
						content: [{ type: "text", text: "No ready stories available right now." }],
						details: { action, story: null },
					};
				}
				return {
					content: [{ type: "text", text: `Next story to work on:\n${storyToText(topReady, false)}` }],
					details: { action, story: topReady },
				};
			}

			// ── set_top_level ────────────────────────────────────
			if (action === "set_top_level") {
				if (!params.story_id) {
					return { content: [{ type: "text", text: "Error: story_id required for set_top_level" }], details: { action, error: "missing story_id" } };
				}
				const story = getStoryById(db, params.story_id);
				if (!story) {
					return { content: [{ type: "text", text: `Story #${params.story_id} not found` }], details: { action, error: "not found" } };
				}
				setAppState(db, "top_level_story_id", String(story.id));
				return {
					content: [{ type: "text", text: `Top-level story set to #${story.id}: ${story.title}` }],
					details: { action, story },
				};
			}

			// ── reorder ──────────────────────────────────────────
			if (action === "reorder") {
				if (!params.ordered_ids || params.ordered_ids.length === 0) {
					return { content: [{ type: "text", text: "Error: ordered_ids required for reorder" }], details: { action, error: "missing ordered_ids" } };
				}
				// Validate all IDs exist
				for (const id of params.ordered_ids) {
					if (!getStoryById(db, id)) {
						return { content: [{ type: "text", text: `Story #${id} not found` }], details: { action, error: "not found" } };
					}
				}
				// Assign priority and chain next_id
				for (let i = 0; i < params.ordered_ids.length; i++) {
					const id = params.ordered_ids[i];
					const nextId = i + 1 < params.ordered_ids.length ? params.ordered_ids[i + 1] : null;
					updateStory(db, id, { priority: i, next_id: nextId });
				}
				const reordered = params.ordered_ids.map((id) => getStoryById(db, id)!);
				return {
					content: [{ type: "text", text: `Reordered ${reordered.length} stories. New order:\n${reordered.map((s) => `#${s.id}: ${s.title}`).join("\n")}` }],
					details: { action, stories: reordered },
				};
			}

			// ── simplify ─────────────────────────────────────────
			if (action === "simplify") {
				if (!params.source_ids || params.source_ids.length < 2) {
					return { content: [{ type: "text", text: "Error: simplify requires at least 2 source_ids" }], details: { action, error: "not enough sources" } };
				}
				const sources = params.source_ids.map((id) => getStoryById(db, id)).filter(Boolean) as Story[];
				if (sources.length < 2) {
					return { content: [{ type: "text", text: "Error: could not locate all source stories" }], details: { action, error: "missing sources" } };
				}
				const mergedTitle = params.merged_title ?? `Merged: ${sources.map((s) => s.title).join(" + ")}`;
				const mergedSubGoal = sources.map((s) => s.sub_goal).join("\n");
				const mergedChanges = sources.map((s) => s.proposed_changes).join("\n---\n");
				const first = sources[0];
				const sourceIds = new Set(sources.map((s) => s.id));
				// Keep the epic when every source sat under the same one.
				const sharedParent = sources.every((s) => s.parent_id === first.parent_id) ? first.parent_id : null;

				const merged = transaction(db, () => {
					const created = createStory(db, {
						title: mergedTitle,
						sub_goal: mergedSubGoal,
						proposed_changes: mergedChanges,
						status: first.status === "done" ? "done" : first.status === "in_progress" ? "in_progress" : "ready",
						priority: first.priority,
						parent_id: sharedParent,
						next_id: first.next_id,
						// A merge must not depend on the parts it absorbed.
						depends_on: [...new Set(sources.flatMap((s) => s.depends_on))].filter((id) => !sourceIds.has(id)),
					});

					for (const s of sources) {
						// Adopt the sources' children so they aren't stranded on archived rows.
						for (const child of getChildren(db, s.id)) {
							if (child.id !== created.id) {
								updateStory(db, child.id, { parent_id: created.id });
							}
						}
						// Deliberately not transitionStatus: this runs inside a SQLite
						// transaction, which cannot hold open across a git subprocess.
						// It is also bookkeeping rather than work finishing — these
						// stories never had a commit, so archiving them must not
						// produce one out of whatever happens to be in the tree.
						updateStory(db, s.id, {
							status: "archived",
							resolution: "superseded",
							resolution_note: `Merged into #${created.id}`,
						});
					}

					// Repoint anyone depending on a source; archived never becomes done,
					// so those dependents would otherwise be blocked forever.
					for (const other of getAllStories(db)) {
						if (other.id === created.id || sourceIds.has(other.id)) continue;
						if (!other.depends_on.some((id) => sourceIds.has(id))) continue;
						const rewritten = [...new Set(other.depends_on.map((id) => (sourceIds.has(id) ? created.id : id)))];
						updateStory(db, other.id, { depends_on: rewritten });
					}

					return created;
				});

				refreshStatus(ctx);
				return {
					content: [
						{
							type: "text",
							text: `Simplified ${sources.length} stories into #${merged.id}: ${merged.title}\n\nSources archived: ${sources.map((s) => `#${s.id}`).join(", ")}\n\n${storyToText(merged, false)}`,
						},
					],
					details: { action, merged, sources },
				};
			}

			return { content: [{ type: "text", text: `Unknown action: ${action}` }], details: { action, error: "unknown" } };
		},

		// TUI render
		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("story ")) + theme.fg("muted", String(args.action));
			if (args.story_id !== undefined) text += ` #${args.story_id}`;
			if (args.title) text += ` "${theme.fg("dim", args.title as string)}"`;
			if (args.query) text += ` "${theme.fg("dim", args.query as string)}"`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as Record<string, unknown> | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}
			if (details.story) {
				const s = details.story as Story;
				return new Text(theme.fg("success", "✓ ") + theme.fg("accent", `#${s.id} `) + theme.fg("muted", s.title), 0, 0);
			}
			if (details.merged) {
				const m = details.merged as Story;
				return new Text(theme.fg("success", "✓ Merged into ") + theme.fg("accent", `#${m.id} `) + theme.fg("muted", m.title), 0, 0);
			}
			if (details.stories) {
				const ss = (details.stories as Story[]).slice(0, 5);
				const lines = ss.map((s) => `${theme.fg("accent", `#${s.id}`)} ${theme.fg("muted", s.title)}`).join("\n");
				return new Text(lines + (((details.stories as Story[]).length > 5) ? theme.fg("dim", `\n... ${(details.stories as Story[]).length - 5} more`) : ""), 0, 0);
			}
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	// ── Commands ────────────────────────────────────────────────────

	// /stories — show a scrollable list in TUI
	pi.registerCommand("stories", {
		description: "Open the story board (interactive list)",
		handler: async (_args, ctx) => {
			if (!isDbReady()) {
				if (ctx.hasUI) ctx.ui.notify("Story DB not ready", "error");
				return;
			}
			const db = ensureDb();
			const all = getAllStories(db);
			if (ctx.mode !== "tui") {
				const open = all.filter(isOpen);
				const text = open.map((s) => storyToText(s, true)).join("\n") || "All stories are closed.";
				if (ctx.hasUI) ctx.ui.notify(`${all.length} stories total, ${open.length} open:\n\n${text}`, "info");
				return;
			}

			const result = await ctx.ui.custom<Story | null>((tui, theme, _kb, done) => {
				let selectedIndex = 0;
				let cachedLines: string[] | undefined;
				let widthCached = 0;
				// Epics first, children indented beneath them.
				const rows = treeOrder(all);

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				/**
				 * Board keys are human actions, so they don't hit the tool's resolution
				 * gate — but a closed story with no resolution is exactly the hole this
				 * work fills, so record a default.
				 */
				function setStatus(index: number, updates: Partial<Story>) {
					const row = rows[index];
					if (!row) return;
					// Key handlers are synchronous, but a transition now performs git
					// work. Refresh when it lands rather than blocking the board.
					void transitionStatus(row.story.id, updates).then((updated) => {
						if (updated) rows[index] = { ...row, story: updated };
						refresh();
					});
				}

				function handleInput(data: string) {
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
						done(null);
						return;
					}
					if (matchesKey(data, "up")) {
						selectedIndex = Math.max(0, selectedIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, "down")) {
						selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
						refresh();
						return;
					}
					if (matchesKey(data, "r")) {
						setStatus(selectedIndex, { status: "ready" });
						return;
					}
					if (matchesKey(data, "s")) {
						setStatus(selectedIndex, { status: "in_progress" });
						return;
					}
					if (matchesKey(data, "d")) {
						setStatus(selectedIndex, {
							status: "done",
							resolution: "completed",
							resolution_note: "Closed from the story board.",
						});
						return;
					}
					if (matchesKey(data, "x")) {
						setStatus(selectedIndex, {
							status: "cancelled",
							resolution: "wontfix",
							resolution_note: "Cancelled from the story board.",
						});
						return;
					}
					if (matchesKey(data, "enter")) {
						done(rows[selectedIndex]?.story ?? null);
					}
				}

				function render(width: number): string[] {
					if (cachedLines && widthCached === width) return cachedLines;
					const lines: string[] = [];
					const openCount = rows.filter((r) => isOpen(r.story)).length;
					lines.push(theme.fg("accent", "═".repeat(Math.max(0, width))));
					lines.push(` ${theme.fg("accent", theme.bold("Story Board"))}  ${theme.fg("muted", `${openCount} open`)}`);
					lines.push(theme.fg("accent", "─".repeat(Math.max(0, width))));

					if (rows.length === 0) {
						lines.push(`  ${theme.fg("dim", "No stories yet. Use /plan-stories <goal> to create some.")}`);
					}

					for (let i = 0; i < rows.length; i++) {
						const { story: s, depth } = rows[i];
						const isActive = i === selectedIndex;
						const statusColor =
							s.status === "done"
								? "success"
								: s.status === "in_progress"
									? "accent"
									: s.status === "ready"
										? "text"
										: "dim";
						const indent = "  ".repeat(depth);
						const prefix = isActive ? theme.fg("accent", "> ") : "  ";
						const epicMark = hasChildren(db, s.id) ? theme.fg("muted", "▾ ") : "";
						const row = `${prefix}${indent}${epicMark}${theme.fg(statusColor, `[${s.status}]`)} ${theme.fg("accent", `#${s.id}`)} ${theme.fg("text", s.title)}`;
						lines.push(row);
						if (isActive) {
							const pad = `     ${indent}`;
							lines.push(`${pad}${theme.fg("dim", truncate(s.sub_goal, Math.max(10, width - pad.length - 1)))}`);
							if (s.next_id) {
								lines.push(`${pad}${theme.fg("dim", `Next → #${s.next_id}`)}`);
							}
							if (s.resolution) {
								lines.push(`${pad}${theme.fg("muted", `Resolution: ${s.resolution}${s.resolution_note ? ` — ${s.resolution_note}` : ""}`)}`);
							}
							if (s.learnings) {
								lines.push(`${pad}${theme.fg("warning", `⚠ ${truncate(s.learnings, Math.max(10, width - pad.length - 3))}`)}`);
							}
						}
					}

					lines.push(theme.fg("accent", "─".repeat(Math.max(0, width))));
					lines.push(`  ${theme.fg("dim", "↑↓ navigate • R ready • S start • D done • X cancel • Enter detail • Esc close")}`);
					lines.push(theme.fg("accent", "═".repeat(Math.max(0, width))));
					cachedLines = lines;
					widthCached = width;
					return lines;
				}

				return { render, handleInput, invalidate: () => { cachedLines = undefined; } };
			});

			refreshStatus(ctx);
			if (result) {
				ctx.ui.notify(`Selected #${result.id}: ${result.title}`, "info");
			}
		},
	});

	// /stories plan <goal>
	pi.registerCommand("plan-stories", {
		description: "Break down a high-level goal into user stories",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/plan-stories requires interactive mode", "error");
				return;
			}
			if (!isDbReady()) {
				ctx.ui.notify("Story DB not ready", "error");
				return;
			}
			const db = ensureDb();
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /plan-stories <high-level goal>", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// First pass: ask for clarifications or a story breakdown.
			// Note the goal itself becomes the root epic below, so the model is asked
			// only for leaf work — parent_index is for an optional *second* level.
			const baseSystemPrompt = `You are a requirements assistant. The user wants to break down a high-level goal into user stories.\n\nOnly ask clarifying questions if the goal is genuinely ambiguous and you cannot produce a reasonable breakdown (e.g., missing critical constraints, conflicting requirements, or undefined scope). If the goal is reasonably clear, make sensible assumptions and respond ONLY with a JSON array of user stories.\n\nIf you MUST clarify, respond with a short list of 1-3 clarifying questions, prefixed by ">>> CLARIFY:". Each question must be meaningful and non-empty.\n\nOtherwise, respond ONLY with a JSON array of user stories. Each story must have:\n- title (string)\n- sub_goal (string, 1-2 sentences)\n- proposed_changes (string, bullet or numbered list of concrete code/file changes)\n- depends_on (array of 0-based indices referencing earlier array items; optional)\n- parent_index (number | null, 0-based index of an earlier item that groups this story; optional)\n\nThe overall goal is already tracked separately as the parent of everything you return, so do NOT emit a story for the goal itself. Use parent_index only when a group of stories forms a distinct sub-area worth grouping under one of your own items; leave it out otherwise.\n\nDo NOT include markdown code fences around the JSON. Keep it compact and valid JSON. If dependencies or parent references exist, ensure they reference earlier indices only.`;

			let storiesJson: PlanItem[] | null = null;
			let clarifications: string[] | null = null;
			let turn = 0;
			const maxTurns = 3;

			// Planning is a command, so these tokens never reach the built-in footer
			// counter. Total them here and surface them ourselves.
			const usage = emptyUsage();
			// One id across turns so the shared system prompt can actually cache.
			const planSessionId = randomUUID();

			const reportUsage = () => {
				if (!hasUsage(usage)) return;
				ctx.ui.setStatus("issue-tracker-planning", `plan ${formatUsage(usage)}`);
			};

			while (turn < maxTurns && !storiesJson) {
				const systemPrompt = turn === maxTurns - 1
					? baseSystemPrompt + "\n\nIMPORTANT: This is your final chance. Do NOT ask for clarification. Produce the JSON array directly."
					: baseSystemPrompt;
				const contentText = turn === 0 && !clarifications
					? goal
					: `Goal: ${goal}\n\n${clarifications ? `Clarifications:\n${clarifications.join("\n")}` : ""}`;

				// Run model call with persistent loader so the user sees activity and can abort
				type PlanTurn = { text: string | null; usage?: Usage; error?: string };
				const outcome = await ctx.ui.custom<PlanTurn | null>((tui, theme, _kb, done) => {
					// BorderedLoader's label is fixed at construction, but we build a new
					// one each turn — so running totals go straight into the message.
					const runningTotal = hasUsage(usage) ? ` · ${formatUsage(usage)} so far` : "";
					const loader = new BorderedLoader(
						tui,
						theme,
						`Planning stories (turn ${turn + 1}/${maxTurns}) using ${ctx.model!.id}…${runningTotal}`,
					);
					loader.onAbort = () => done(null);

					const doPlan = async (): Promise<PlanTurn> => {
						try {
							const response = await ctx.modelRegistry.complete(
								ctx.model!,
								{
									systemPrompt,
									messages: [
										{ role: "user" as const, content: [{ type: "text" as const, text: contentText }], timestamp: Date.now() },
									],
								},
								{ sessionId: planSessionId, signal: loader.signal },
							);
							// Aborted turns still burn tokens, so report usage before bailing.
							if (response.stopReason === "aborted") return { text: null, usage: response.usage };
							if (response.stopReason === "length") {
								return { text: null, usage: response.usage, error: "The model hit its output limit before finishing the plan. Try a narrower goal." };
							}
							const text = response.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("\n")
								.trim();
							return { text, usage: response.usage };
						} catch (err) {
							return { text: null, error: err instanceof Error ? err.message : String(err) };
						}
					};

					doPlan().then(done).catch((err) => done({ text: null, error: String(err) }));
					return loader;
				});

				// null only comes from the abort path; a failure carries an error string.
				if (outcome === null) {
					reportUsage();
					ctx.ui.notify(`Planning cancelled.${hasUsage(usage) ? ` Used ${formatUsage(usage)}.` : ""}`, "info");
					return;
				}
				addUsage(usage, outcome.usage);
				reportUsage();

				if (outcome.text === null) {
					ctx.ui.notify(`Planning failed: ${outcome.error ?? "unknown error"}`, "error");
					return;
				}
				const responseText = outcome.text;

				const parsePlan = (text: string): PlanItem[] | null => {
					try {
						return coercePlanItems(JSON.parse(extractJsonArray(text)));
					} catch {
						return null;
					}
				};

				if (responseText.includes(">>> CLARIFY")) {
					const qs = responseText.split(">>> CLARIFY")[1]?.split("\n")
						.filter((l) => l.trim().startsWith("-") || /^\d+\./.test(l.trim()))
						.map((l) => l.replace(/^[-\d\.\s]+/, "").trim())
						.filter((q) => q.length > 0) ?? [];
					if (qs.length === 0) {
						// Unexpected format, treat as JSON attempt
						storiesJson = parsePlan(responseText);
						if (!storiesJson) {
							ctx.ui.notify("Could not parse plan response. Aborting.", "error");
							return;
						}
					} else {
						// Ask user clarifications. The question goes in the TITLE — the
						// input component ignores its placeholder argument entirely.
						const answers: string[] = [];
						for (let i = 0; i < qs.length; i++) {
							const q = qs[i];
							const ans = await ctx.ui.input(`Clarification ${i + 1}/${qs.length}: ${q}`, "");
							if (ans === undefined) {
								ctx.ui.notify("Planning cancelled", "info");
								return;
							}
							answers.push(`${q}\nAnswer: ${ans}`);
						}
						clarifications = answers;
					}
				} else {
					storiesJson = parsePlan(responseText);
					if (!storiesJson) {
						ctx.ui.notify("Could not parse JSON plan. Aborting.", "error");
						return;
					}
				}
				turn++;
			}

			if (!storiesJson || storiesJson.length === 0) {
				ctx.ui.notify("No stories generated after clarification loop.", "warning");
				return;
			}

			const { items, warnings } = repairStoryGraph(storiesJson);
			if (warnings.length > 0) {
				ctx.ui.notify(`Plan repaired:\n${warnings.join("\n")}`, "warning");
			}

			// Keep this run's stories after any existing ones instead of restarting at 0.
			const basePriority = getMaxPriority(db) + 1;

			const { rootId, createdIds } = transaction(db, () => {
				// The goal itself becomes the root epic. Without it there is no parent
				// for anything to attach to, which is why parent_id was always null.
				const root = createStory(db, {
					title: truncate(goal, 80),
					sub_goal: goal,
					proposed_changes: `Delivered by the child stories of this epic.`,
					status: "draft",
					priority: basePriority,
					parent_id: null,
					next_id: null,
					depends_on: [],
				});

				const ids: number[] = [];
				for (let i = 0; i < items.length; i++) {
					const item = items[i];
					const dependsOn = (item.depends_on ?? [])
						.map((idx) => ids[idx])
						.filter((id): id is number => id !== undefined);
					// Default to the root epic; parent_index overrides it with a sub-group.
					const parentId = item.parent_index != null ? ids[item.parent_index] ?? root.id : root.id;
					const story = createStory(db, {
						title: item.title,
						sub_goal: item.sub_goal,
						proposed_changes: item.proposed_changes,
						status: "draft",
						priority: basePriority + 1 + i,
						parent_id: parentId,
						// Linked in the second pass below; inside this transaction the
						// intermediate state is never externally visible.
						next_id: null,
						depends_on: dependsOn,
					});
					ids.push(story.id);
				}

				// Chain the children; the root epic stays out of the chain.
				for (let i = 0; i < ids.length; i++) {
					updateStory(db, ids[i], { next_id: i + 1 < ids.length ? ids[i + 1] : null });
				}

				// Give the agent something to pick up. Without this everything sits in
				// `draft` and the context injection reports NO ACTIVE WORK.
				const firstReady = ids.find((id) => (getStoryById(db, id)?.depends_on.length ?? 0) === 0);
				if (firstReady !== undefined) {
					// Plain updateStory for the same two reasons as `simplify` above:
					// this is inside a transaction, and `ready` has no git effect —
					// work starts at `in_progress`, which is where a commit is anchored.
					updateStory(db, firstReady, { status: "ready" });
				}

				setAppState(db, "top_level_story_id", String(root.id));
				return { rootId: root.id, createdIds: ids };
			});

			refreshStatus(ctx);
			const costNote = hasUsage(usage) ? `\nPlanning used ${formatUsage(usage)}.` : "";
			ctx.ui.notify(
				`Created epic #${rootId} with ${createdIds.length} stories. Use /stories to view.${costNote}`,
				"info",
			);
		},
	});

	// /top-story <id>
	pi.registerCommand("top-story", {
		description: "Set the top-level story for big-picture context",
		handler: async (args, ctx) => {
			if (!isDbReady()) {
				ctx.ui.notify("Story DB not ready", "error");
				return;
			}
			const db = ensureDb();
			const id = Number(args.trim());
			if (!id || Number.isNaN(id)) {
				ctx.ui.notify("Usage: /top-story <story_id>", "error");
				return;
			}
			const story = getStoryById(db, id);
			if (!story) {
				ctx.ui.notify(`Story #${id} not found`, "error");
				return;
			}
			setAppState(db, "top_level_story_id", String(story.id));
			ctx.ui.notify(`Top-level story set to #${story.id}: ${story.title}`, "info");
		},
	});

	// /stories export [path]
	pi.registerCommand("export-stories", {
		description: "Export stories to a human-readable markdown file",
		handler: async (args, ctx) => {
			if (!isDbReady()) {
				ctx.ui.notify("Story DB not ready", "error");
				return;
			}
			const db = ensureDb();
			const targetPath = (args.trim() || "stories.md").replace(/^~/, process.env.HOME ?? "~");
			const all = getAllStories(db);
			if (all.length === 0) {
				ctx.ui.notify("No stories to export", "warning");
				return;
			}

			const lines: string[] = ["# User Stories", ""];
			// Epics become sections, their children nest one heading level deeper.
			for (const { story: s, depth } of treeOrder(all)) {
				const marker = s.status === "in_progress" ? "▶" : s.status === "done" ? "✓" : s.status === "ready" ? "○" : "•";
				const heading = "#".repeat(Math.min(6, depth + 2));
				lines.push(`${heading} ${marker} #${s.id}: ${s.title}`);
				lines.push(`**Status:** ${s.status}`);
				lines.push(`**Sub-goal:** ${s.sub_goal}`);
				lines.push("**Proposed changes:**");
				for (const change of s.proposed_changes.split("\n")) {
					lines.push(`- ${change}`);
				}
				if (s.parent_id) {
					lines.push(`**Part of:** #${s.parent_id}`);
				}
				if (s.depends_on.length) {
					lines.push(`**Depends on:** ${s.depends_on.map((id) => `#${id}`).join(", ")}`);
				}
				if (s.next_id) {
					lines.push(`**Next →** #${s.next_id}`);
				}
				if (s.resolution) {
					lines.push(`**Resolution:** ${s.resolution}${s.resolution_note ? ` — ${s.resolution_note}` : ""}`);
				}
				if (s.learnings) {
					lines.push(`**Learned:** ${s.learnings}`);
				}
				lines.push("");
			}

			const { writeFileSync } = await import("node:fs");
			const { isAbsolute, join } = await import("node:path");
			const outPath = isAbsolute(targetPath) ? targetPath : join(process.cwd(), targetPath);
			writeFileSync(outPath, lines.join("\n"), "utf-8");
			ctx.ui.notify(`Exported ${all.length} stories to ${outPath}`, "info");
		},
	});

	// ── Git: epic lifecycle ─────────────────────────────────────────
	// Starting and merging an epic are user actions, never the agent's. Merging
	// rewrites the branch the user is sitting on, and pi can only relocate a
	// session from a command handler, so both live here rather than in the tool.

	/**
	 * Split `/start-epic 3 --worktree` into its parts.
	 *
	 * Flags used to be detected with `args.includes("--worktree")` while the id
	 * came from `split(/\s+/)[0]`, so the flag-first spelling would have parsed
	 * `--worktree` as the story id the moment the mode was implemented.
	 */
	function parseArgs(args: string): { tokens: string[]; flags: Set<string> } {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		return {
			tokens: parts.filter((part) => !part.startsWith("--")),
			flags: new Set(parts.filter((part) => part.startsWith("--"))),
		};
	}

	/** Resolve an epic from an explicit id, or fall back to this session's own. */
	function resolveEpic(args: string): { epic?: EpicBranch; error?: string } {
		const db = ensureDb();
		const raw = parseArgs(args).tokens[0] ?? "";
		if (raw) {
			const id = Number(raw);
			if (!Number.isInteger(id)) return { error: `"${raw}" is not a story id` };
			const epic = getEpicBranch(db, id);
			return epic ? { epic } : { error: `epic #${id} has no branch — start it with /start-epic ${id}` };
		}
		const own = sessionEpic();
		return own
			? { epic: own }
			: { error: "this session is not working on an epic — pass an id, or start one with /start-epic" };
	}

	/**
	 * Move this session into `targetCwd`, carrying its history.
	 *
	 * The only true relocation pi offers: `ctx.cwd` is a read-only getter, the
	 * built-in tools capture their directory at construction, and
	 * `process.chdir()` is inert. `forkFrom` writes a new session file whose
	 * header records the new directory, and `switchSession` rebinds the runtime
	 * to it.
	 *
	 * Everything after the switch must go through the replacement context. By the
	 * time `withSession` runs, the old session has emitted `session_shutdown` and
	 * every session-bound object captured beforehand — including `ctx` and
	 * `ctx.sessionManager` — throws if touched.
	 */
	async function relocateSession(
		ctx: ExtensionCommandContext,
		targetCwd: string,
		after: (rc: ExtensionCommandContext) => Promise<void>,
	): Promise<{ ok: boolean; note: string }> {
		const sourceSession = ctx.sessionManager.getSessionFile();

		// `forkFrom` carries the conversation across, but it refuses an empty or
		// unwritten source file — which is the most likely case of all: open pi,
		// run /start-epic --worktree before saying anything. There is no history to
		// carry there, so a fresh session in the target directory is not a fallback
		// so much as the right answer.
		let relocated: string | undefined;
		try {
			relocated = sourceSession
				? SessionManager.forkFrom(sourceSession, targetCwd).getSessionFile()
				: SessionManager.create(targetCwd).getSessionFile();
		} catch {
			try {
				relocated = SessionManager.create(targetCwd).getSessionFile();
			} catch (error) {
				return { ok: false, note: `could not open a session in ${targetCwd}: ${String(error)}` };
			}
		}
		if (!relocated) return { ok: false, note: `could not open a session in ${targetCwd}` };

		const result = await ctx.switchSession(relocated, { withSession: async (rc) => after(rc) });
		return result.cancelled
			? { ok: false, note: "an extension cancelled the session switch" }
			: { ok: true, note: `session moved to ${targetCwd}` };
	}

	pi.registerCommand("start-epic", {
		description:
			"Start an epic on its own branch, or in its own worktree (usage: /start-epic <story_id> [--worktree])",
		handler: async (args, ctx) => {
			if (!isDbReady()) return void ctx.ui.notify("Story DB not ready", "error");
			const tracked = ensureTracker();
			const db = tracked.db;

			const { tokens, flags } = parseArgs(args);
			const mode: EpicMode = flags.has("--worktree") ? "worktree" : "branch";
			const id = Number(tokens[0]);
			if (!Number.isInteger(id)) {
				return void ctx.ui.notify("Usage: /start-epic <story_id> [--worktree]", "error");
			}

			const story = getStoryById(db, id);
			const branch = await currentBranch(tracked.git, tracked.paths.repoRoot);
			const dirty = await isDirty(tracked.git, tracked.paths.repoRoot);

			// Worktree mode collides on two things branch mode cannot: a branch that
			// already exists, and a directory already sitting where it would go.
			const worktreePath = story ? epicWorktreePath(tracked, story) : "";
			const input = {
				isRepo: repo?.isRepo ?? false,
				branch,
				dirty,
				story,
				childCount: story ? getChildren(db, story.id).length : 0,
				mode,
				activeEpics: getActiveEpicBranches(db),
				branchExists:
					mode === "worktree" && story
						? (await revParse(tracked.git, `refs/heads/${epicBranchName(story)}`, tracked.paths.repoRoot)) !== null
						: false,
				pathExists: mode === "worktree" && story ? existsSync(worktreePath) : false,
			};

			let carryDirty = false;
			let check = checkCanStartEpic(input);
			if (!check.ok && dirty && checkCanStartEpic({ ...input, carryDirty: true }).ok) {
				// Refusing outright over a dirty tree is what makes people work
				// around the tool, so offer to bring the changes along instead.
				const choice = ctx.hasUI
					? await ctx.ui.select("You have uncommitted changes. Carry them onto the epic branch?", [
							"Yes, commit them as the epic's first commit",
							"No, let me handle them first",
						])
					: undefined;
				if (!choice?.startsWith("Yes")) {
					return void ctx.ui.notify("Commit or stash your changes, then run /start-epic again.", "warning");
				}
				carryDirty = true;
				check = checkCanStartEpic({ ...input, carryDirty: true });
			}
			if (!check.ok) return void ctx.ui.notify(`Cannot start epic: ${check.reason}`, "error");

			// A worktree checkout plus the manifest's setup command is the slowest
			// thing this extension does, and it otherwise happens with no output.
			const start = () => serializeGit(() => startEpic(tracked, { story: story!, mode, carryDirty }));
			const started =
				mode === "worktree" && ctx.mode === "tui"
					? await ctx.ui.custom<Awaited<ReturnType<typeof start>>>((tui, theme, _kb, done) => {
							const loader = new BorderedLoader(tui, theme, `Creating a worktree for epic #${id}...`);
							start().then(done, (error) => done({ ok: false, note: String(error) }));
							return loader;
						})
					: await start();

			if (!started.ok || !started.epic) return void ctx.ui.notify(started.note, "error");

			// Every database write has to land before the switch: the session that
			// makes them is about to be torn down.
			await transitionStatus(story!.id, { status: "in_progress" }, ctx);
			sessionEpicId = started.epic.epic_id;

			if (mode !== "worktree" || !started.epic.path) {
				return void ctx.ui.notify(started.note, "info");
			}

			const note = started.note;
			const worktree = started.epic.path;
			const moved = await relocateSession(ctx, worktree, async (rc) => {
				rc.ui.notify(`${note}\nThis session is now working in the worktree.`, "info");
			});
			if (!moved.ok) {
				// The worktree exists and the epic is recorded; only the session
				// failed to follow. Say exactly that, because the recovery is to open
				// pi in the worktree, not to start the epic again.
				ctx.ui.notify(
					`${note}\nBut the session could not move: ${moved.note}. Start pi in ${worktree} to work on it.`,
					"warning",
				);
			}
		},
	});

	/**
	 * Land a merge, then take the worktree down and offer to tidy the refs.
	 *
	 * Everything here runs *after* any session relocation, against a freshly
	 * resolved tracker — the one captured before a switch belongs to a torn-down
	 * session.
	 */
	async function finishMerge(epic: EpicBranch, ctx: ExtensionCommandContext): Promise<void> {
		const tracked = ensureTracker();
		const merged = await serializeGit(() => mergeIntoBase(tracked, epic));
		if (!merged.ok) return void ctx.ui.notify(merged.note, "error");

		const notes = [merged.note];
		const current = getEpicBranch(tracked.db, epic.epic_id) ?? epic;

		if (current.mode === "worktree" && current.path) {
			const released = await serializeGit(() => releaseWorktree(tracked, current));
			notes.push(released.ok ? released.note : `${released.note} — remove it by hand when you can.`);
		}
		if (sessionEpicId === epic.epic_id) sessionEpicId = null;

		// Reported before the prune question, not after it. Pruning is an optional
		// afterthought and the merge is the thing the user asked for; making them
		// answer a dialog before learning whether it worked gets that backwards.
		ctx.ui.notify(notes.join("\n"), "info");
		await offerToPrune(epic.epic_id, "pre-merge", "The merge stays undoable either way.", ctx);
	}

	/**
	 * Offer to delete an epic's refs, always keeping the one its undo depends on.
	 *
	 * Backup refs are the safety net that gives every command an inverse, so they
	 * are never pruned on their own — only when the user says so, and never the
	 * ref that would make the operation they just ran irreversible.
	 */
	async function offerToPrune(
		epicId: number,
		keep: string,
		reassurance: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (!ctx.hasUI) return;
		const choice = await ctx.ui.select(`Prune epic #${epicId}'s checkpoints and backup refs? ${reassurance}`, [
			"No, keep them",
			`Yes, prune all but ${keep}`,
		]);
		if (!choice?.startsWith("Yes")) return;

		const tracked = ensureTracker();
		const pruned = await serializeGit(() => pruneEpicRefs(tracked, epicId, [keep]));
		ctx.ui.notify(`Pruned ${pruned} ref(s) for epic #${epicId}.`, "info");
	}

	pi.registerCommand("merge-epic", {
		description: "Merge a finished epic into its base branch (usage: /merge-epic [story_id])",
		handler: async (args, ctx) => {
			if (!isDbReady()) return void ctx.ui.notify("Story DB not ready", "error");
			const tracked = ensureTracker();
			const { epic, error } = resolveEpic(args);
			if (!epic) return void ctx.ui.notify(error!, "error");
			if (epic.state !== "active") return void ctx.ui.notify(`Epic #${epic.epic_id} is already ${epic.state}.`, "warning");

			const gate = checkCanMerge({
				epic,
				baseCheckedOutAt: await branchCheckoutLocation(tracked.git, tracked.paths.repoRoot, epic.base_branch),
				repoRoot: tracked.paths.repoRoot,
				mainCheckoutEpicId: getActiveBranchModeEpic(tracked.db)?.epic_id ?? null,
			});
			if (!gate.ok) return void ctx.ui.notify(`Cannot merge: ${gate.reason}`, "error");

			// Re-run step 1 in case the base branch moved since the epic closed;
			// step 2 is fast-forward-only and would otherwise refuse. It runs in the
			// worktree, so conflicts land where the agent has been working.
			const updated = await serializeGit(() => updateFromBase(tracked, epic));
			if (!updated.ok) return void ctx.ui.notify(updated.note, "error");

			// Merging rewrites the branch the user is on, so it is always confirmed.
			if (ctx.hasUI) {
				const choice = await ctx.ui.select(`Merge ${epic.branch} into ${epic.base_branch}?`, [
					`Yes, fast-forward ${epic.base_branch}`,
					"No, leave the branch for me",
				]);
				if (!choice?.startsWith("Yes")) return void ctx.ui.notify("Left the epic branch as it is.", "info");
			} else {
				return void ctx.ui.notify(
					`Epic #${epic.epic_id} is ready, but merging needs confirmation. Run /merge-epic interactively.`,
					"warning",
				);
			}

			// If this session is standing in the worktree we are about to delete, it
			// has to move out first — removing the directory a session is sitting in
			// breaks the session.
			const inside = sessionIsInsideWorktreeOf(epic);
			if (!inside) return void (await finishMerge(epic, ctx));

			const epicId = epic.epic_id;
			const moved = await relocateSession(ctx, tracked.paths.repoRoot, async (rc) => {
				const fresh = getEpicBranch(ensureTracker().db, epicId);
				if (fresh) await finishMerge(fresh, rc);
			});
			if (!moved.ok) {
				ctx.ui.notify(`Nothing merged: ${moved.note}. The epic is untouched.`, "error");
			}
		},
	});

	/**
	 * Whether this session is standing in the directory `epic` is about to lose.
	 *
	 * Asked of the resolved session epic rather than by comparing `ctx.cwd` to
	 * `epic.path`: the path match was already done once, carefully, at
	 * `session_start` — `resolveSessionEpic` normalises through git — and
	 * repeating it as raw string equality here would reintroduce exactly the
	 * symlink mismatch that resolution exists to avoid.
	 */
	function sessionIsInsideWorktreeOf(epic: EpicBranch): boolean {
		return epic.mode === "worktree" && epic.path !== null && sessionEpicId === epic.epic_id;
	}

	/** Cancel, then offer to prune. Runs after any relocation, like `finishMerge`. */
	async function finishCancel(epic: EpicBranch, ctx: ExtensionCommandContext): Promise<void> {
		const tracked = ensureTracker();
		const result = await serializeGit(() => cancelEpic(tracked, epic));
		if (!result.ok) return void ctx.ui.notify(result.note, "error");
		if (sessionEpicId === epic.epic_id) sessionEpicId = null;

		ctx.ui.notify(result.note, "info");
		// pre-cancel holds the abandoned work; pruning it would make the cancel
		// irreversible, which is the one thing it promises not to be.
		await offerToPrune(epic.epic_id, "pre-cancel", "The abandoned work stays reachable either way.", ctx);
	}

	pi.registerCommand("cancel-epic", {
		description: "Stop an epic without merging; its branch is kept (usage: /cancel-epic [story_id])",
		handler: async (args, ctx) => {
			if (!isDbReady()) return void ctx.ui.notify("Story DB not ready", "error");
			const tracked = ensureTracker();
			const { epic, error } = resolveEpic(args);
			if (!epic) return void ctx.ui.notify(error!, "error");

			// Same reason as /merge-epic: cancelling a worktree epic removes its
			// directory, and a session cannot be standing in it when that happens.
			const inside = sessionIsInsideWorktreeOf(epic);
			if (!inside) return void (await finishCancel(epic, ctx));

			const epicId = epic.epic_id;
			const moved = await relocateSession(ctx, tracked.paths.repoRoot, async (rc) => {
				const fresh = getEpicBranch(ensureTracker().db, epicId);
				if (fresh) await finishCancel(fresh, rc);
			});
			if (!moved.ok) {
				ctx.ui.notify(`Nothing cancelled: ${moved.note}. The epic is untouched.`, "error");
			}
		},
	});

	pi.registerCommand("undo-story", {
		description: "Reverse one story's commit (usage: /undo-story <story_id>)",
		handler: async (args, ctx) => {
			if (!isDbReady()) return void ctx.ui.notify("Story DB not ready", "error");
			const tracked = ensureTracker();
			const id = Number(parseArgs(args).tokens[0]);
			if (!Number.isInteger(id)) return void ctx.ui.notify("Usage: /undo-story <story_id>", "error");

			const epic = findEpicForStory(tracked, id);
			if (!epic) return void ctx.ui.notify(`Story #${id} is not part of an active epic.`, "error");

			const result = await serializeGit(() => undoStory(tracked, id, epic));
			ctx.ui.notify(result.note, result.ok ? "info" : "error");
		},
	});

	pi.registerCommand("undo-merge", {
		description: "Put the base branch back where it was before /merge-epic (usage: /undo-merge [story_id])",
		handler: async (args, ctx) => {
			if (!isDbReady()) return void ctx.ui.notify("Story DB not ready", "error");
			const tracked = ensureTracker();
			const raw = parseArgs(args).tokens[0] ?? "";
			const db = tracked.db;
			// Unlike the others this defaults to the most recently merged epic,
			// because by definition no epic is active once its merge has landed.
			// "Most recent" is by `updated_at` — when the merge landed — not by when
			// the epic started; with concurrent epics those are different questions.
			const epic = raw ? getEpicBranch(db, Number(raw)) : getLastMergedEpicBranch(db);
			if (!epic) return void ctx.ui.notify("No merged epic to undo — pass a story id.", "error");

			const result = await serializeGit(() => undoMerge(tracked, epic));
			ctx.ui.notify(result.note, result.ok ? "info" : "error");
		},
	});

	pi.registerCommand("undo-turn", {
		description: "Restore the working tree to the last turn's checkpoint",
		handler: async (_args, ctx) => {
			if (!isDbReady()) return void ctx.ui.notify("Story DB not ready", "error");
			const tracked = ensureTracker();
			const epic = sessionEpic();
			if (!epic) {
				return void ctx.ui.notify(
					"This session is not working on an epic, so no checkpoints are being taken.",
					"warning",
				);
			}

			const result = await serializeGit(async () => {
				const cwd = epicCwd(tracked, epic);
				// Names are millisecond timestamps, so they are fixed width and
				// sort newest-first by name alone.
				const refs = await tracked.git(
					["for-each-ref", "--sort=-refname", "--format=%(objectname)", checkpointRefPrefix(epic.epic_id)],
					{ cwd },
				);
				const newest = refs.stdout.trim().split("\n").filter(Boolean)[0];
				if (!newest) return { ok: false, note: "No checkpoint recorded yet." };
				const applied = await tracked.git(["stash", "apply", newest], { cwd });
				return applied.code === 0
					? { ok: true, note: `Restored the working tree from checkpoint ${newest.slice(0, 8)}.` }
					: { ok: false, note: `Could not apply the checkpoint: ${applied.stderr.trim()}` };
			});
			ctx.ui.notify(result.note, result.ok ? "info" : "error");
		},
	});

	// ── Per-turn checkpoints ────────────────────────────────────────
	// `stash create` builds a commit object without touching the working tree or
	// the index, so a checkpoint costs nothing and interrupts nothing. It would
	// be a dangling commit, so a ref is written to keep it from being collected.
	pi.on("turn_end", async () => {
		const tracked = tracker;
		if (!tracked) return;
		const epic = sessionEpic();
		if (!epic) return;

		await serializeGit(async () => {
			const cwd = epicCwd(tracked, epic);
			const created = await tracked.git(["stash", "create"], { cwd });
			const sha = created.stdout.trim();
			if (created.code !== 0 || !sha) return; // clean tree — nothing to checkpoint
			await tracked.git(["update-ref", `${checkpointRefPrefix(epic.epic_id)}/${tracked.now()}`, sha], { cwd });
			// One ref per turn adds up over a day-long epic and only the newest is
			// ever read, so the tail is pruned here rather than by a sweeper.
			await pruneCheckpoints(tracked, epic, CHECKPOINT_RETENTION);
		});
	});

	// ── Branch guard ────────────────────────────────────────────────
	// The agent cannot be stopped from leaving the epic branch, but the handful
	// of commands that actually strand an epic are cheap to intercept.
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		const tracked = tracker;
		if (!tracked) return;
		const epic = sessionEpic();
		if (!epic) return;

		const command = (event.input as { command?: unknown } | undefined)?.command;
		if (typeof command !== "string" || !isBranchEscapingCommand(command)) return;

		return {
			block: true,
			reason:
				`Epic #${epic.epic_id} is active on ${epic.branch}. Switching branches, hard-resetting or ` +
				`deleting branches would strand its work. Use /merge-epic, /cancel-epic, /undo-story or ` +
				`/undo-turn instead.`,
		};
	});
}
