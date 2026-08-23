import type { EpicBranch, EpicMode, Story, StoryCommit } from "./types.ts";

/**
 * Decisions, with no I/O.
 *
 * Everything here is a pure function of plain data, so the branching that
 * actually matters — what blocks an epic, how to undo a story — is tested
 * without a repository, a database, or a clock. `src/epic.ts` calls these and
 * then performs.
 */

/** Never used as a base branch: an epic must start from a working branch. */
export const PROTECTED_BRANCHES = ["main", "master"] as const;

export type CheckResult = { ok: true } | { ok: false; reason: string };

/** Just enough of an active epic to reason about whether another may start. */
export interface ActiveEpicSummary {
	epic_id: number;
	mode: EpicMode;
	branch: string;
	path: string | null;
}

export interface StartEpicInput {
	isRepo: boolean;
	/** Null when HEAD is detached. */
	branch: string | null;
	dirty: boolean;
	story: Story | null;
	/** A unit of work has none; an epic has children. */
	childCount: number;
	/** Branch in place, or in a worktree of its own. */
	mode: EpicMode;
	/** Every epic still active, in either mode. */
	activeEpics: ActiveEpicSummary[];
	/** True once the user has agreed to carry a dirty tree onto the epic branch. */
	carryDirty?: boolean;
	/** Worktree mode: whether `epicBranchName(story)` already exists. */
	branchExists?: boolean;
	/** Worktree mode: whether the target directory is already occupied. */
	pathExists?: boolean;
}

/**
 * Whether an epic may start, and in which mode.
 *
 * The concurrency rule differs by mode, and that difference is the whole point
 * of worktree mode. A branch-mode epic owns the main checkout's HEAD, so at most
 * one can exist. A worktree epic owns a directory nobody else is standing in, so
 * any number can run at once — each in its own pi session.
 */
export function checkCanStartEpic(input: StartEpicInput): CheckResult {
	if (!input.isRepo) return { ok: false, reason: "not a git repository" };
	if (!input.branch) {
		return { ok: false, reason: "HEAD is detached — check out a branch first" };
	}
	if ((PROTECTED_BRANCHES as readonly string[]).includes(input.branch)) {
		return {
			ok: false,
			reason: `refusing to start an epic from ${input.branch} — create a working branch first`,
		};
	}
	if (!input.story) return { ok: false, reason: "story not found" };
	if (input.childCount === 0) {
		return {
			ok: false,
			reason: `story #${input.story.id} is a unit of work, not an epic — it has no child stories`,
		};
	}

	// Restarting a story that is already running is a no-op the caller cannot
	// make sense of, whichever mode either one is in.
	const own = input.activeEpics.find((epic) => epic.epic_id === input.story!.id);
	if (own) {
		return { ok: false, reason: `epic #${own.epic_id} is already active on ${own.branch}` };
	}

	if (input.mode === "worktree") {
		if (input.branchExists) {
			return {
				ok: false,
				reason: `branch ${epicBranchName(input.story)} already exists — delete it, or start the epic in branch mode`,
			};
		}
		if (input.pathExists) {
			return {
				ok: false,
				reason: `${worktreeDirName(input.story)} already exists under the worktree root — remove it first`,
			};
		}
		// No dirty check on purpose: `git worktree add` creates a fresh checkout
		// elsewhere and never touches the current working tree, so there is
		// nothing to carry and nothing worth refusing over.
		return { ok: true };
	}

	const blocking = input.activeEpics.find((epic) => epic.mode === "branch");
	if (blocking) {
		return {
			ok: false,
			reason: `epic #${blocking.epic_id} is still active on this checkout — merge or cancel it, or start this one with --worktree`,
		};
	}
	// Dirty is recoverable rather than fatal: refusing outright is what makes
	// people work around the tool. The caller offers to carry the changes.
	if (input.dirty && !input.carryDirty) {
		return { ok: false, reason: "working tree has uncommitted changes" };
	}
	return { ok: true };
}

export interface MergeEpicInput {
	epic: EpicBranch;
	/** Working tree that currently has `base_branch` checked out, or null. */
	baseCheckedOutAt: string | null;
	repoRoot: string;
	/** The active branch-mode epic holding the main checkout, if there is one. */
	mainCheckoutEpicId: number | null;
}

/**
 * Whether the base branch can be moved right now.
 *
 * Step 2 of a merge fast-forwards the base branch, and git will not move a
 * branch that is checked out. With one epic at a time that could only ever be
 * the main checkout; with concurrent epics the base branch may be sitting in
 * *another session's* worktree, and moving it there would rewrite what somebody
 * else is working on.
 */
export function checkCanMerge(input: MergeEpicInput): CheckResult {
	const { epic } = input;
	if (epic.state !== "active") {
		return { ok: false, reason: `epic #${epic.epic_id} is already ${epic.state}` };
	}
	if (input.baseCheckedOutAt && input.baseCheckedOutAt !== input.repoRoot) {
		return {
			ok: false,
			reason: `${epic.base_branch} is checked out in ${input.baseCheckedOutAt} — finish or move that worktree first`,
		};
	}
	// A branch-mode epic owns the main checkout's HEAD. Fast-forwarding the base
	// branch there would switch that session out from under itself.
	if (
		input.mainCheckoutEpicId !== null &&
		input.mainCheckoutEpicId !== epic.epic_id &&
		epic.mode === "worktree"
	) {
		return {
			ok: false,
			reason: `epic #${input.mainCheckoutEpicId} is active on the main checkout — merge or cancel it before merging #${epic.epic_id}`,
		};
	}
	return { ok: true };
}

/** Lowercase, alphanumerics and single dashes, trimmed. Empty input yields "epic". */
export function slugify(text: string, maxLength = 40): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLength)
		.replace(/-+$/g, "");
	return slug || "epic";
}

export function epicBranchName(story: Story): string {
	return `epic/${story.id}-${slugify(story.title)}`;
}

/** `refs/pi/backup/<epic>/<operation>` — written before anything destructive. */
export function backupRefName(epicId: number, operation: string): string {
	return `refs/pi/backup/${epicId}/${slugify(operation)}`;
}

export function worktreeDirName(story: Story): string {
	return `epic-${story.id}-${slugify(story.title)}`;
}

export interface CommitMessage {
	subject: string;
	body: string;
}

export function storyCommitMessage(story: Story): CommitMessage {
	const resolution = story.resolution ? ` [${story.resolution}]` : "";
	const bodyLines: string[] = [];
	if (story.sub_goal) bodyLines.push(story.sub_goal);
	if (story.resolution_note) bodyLines.push(`Resolution: ${story.resolution_note}`);
	if (story.learnings) bodyLines.push(`Learned: ${story.learnings}`);
	// The handoff note rides into git history on purpose: stories.db has no
	// migrations and is deleted whenever a column is added, so the commit is the
	// copy of this that survives.
	if (story.handoff_notes) bodyLines.push(`Handoff: ${story.handoff_notes}`);
	return {
		subject: `story(#${story.id}): ${story.title}${resolution}`,
		body: bodyLines.join("\n\n"),
	};
}

// ── Review ──────────────────────────────────────────────────────────

/**
 * One thing a review noticed.
 *
 * A `blocker` is a mechanical fact — the story is an epic, its dependencies
 * form a cycle, `verify` failed. No reviewer, independent or self, may record
 * `approved` while one stands; that is what stops a review being a rubber
 * stamp. A `note` is context for whoever judges, and blocks nothing.
 */
export interface ReviewFinding {
	severity: "blocker" | "note";
	message: string;
}

export function hasBlocker(findings: ReviewFinding[]): boolean {
	return findings.some((finding) => finding.severity === "blocker");
}

/** Render findings for a model or a human. Empty reads as a clean bill. */
export function formatFindings(findings: ReviewFinding[]): string {
	if (findings.length === 0) return "No mechanical findings.";
	return findings
		.map((finding) => `${finding.severity === "blocker" ? "BLOCKER" : "note"}: ${finding.message}`)
		.join("\n");
}

/**
 * The first cycle reachable from `startId` by following `edges`, or null.
 *
 * `wouldCreateCycle` guards `parent_id` only, so nothing has ever checked
 * `depends_on` or `next_id`. That was survivable while `/plan-stories` built
 * every graph — `repairStoryGraph` only ever emits backward references. Once an
 * agent authors its own links it can write A→B→A, and every gate then refuses
 * forever with no way back except editing the row by hand.
 *
 * Returns the cycle in visit order, so the message can name it.
 */
export function findCycle(startId: number, edges: (id: number) => number[]): number[] | null {
	const path: number[] = [];
	const onPath = new Set<number>();
	const done = new Set<number>();

	const walk = (id: number): number[] | null => {
		if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];
		if (done.has(id)) return null;
		onPath.add(id);
		path.push(id);
		for (const next of edges(id)) {
			const found = walk(next);
			if (found) return found;
		}
		path.pop();
		onPath.delete(id);
		done.add(id);
		return null;
	};

	return walk(startId);
}

/** Just enough of the graph to review a story's plan without a database. */
export interface PlanReviewInput {
	story: Story;
	/** Direct children. Non-empty means the story is an epic. */
	children: Story[];
	/** Every story, for resolving `depends_on` and `next_id` edges. */
	all: Story[];
	/** Open stories that look like near-duplicates, already scored by the caller. */
	similar?: Story[];
}

const MIN_PROPOSED_CHANGES = 20;

/**
 * Mechanical findings on a story's plan — is it worth starting as written?
 *
 * Pure so every branch is testable without a repository, a database or a model,
 * and so the same findings reach the reviewer model, the self-review path and
 * `/review-story` from one place.
 */
export function reviewPlan(input: PlanReviewInput): ReviewFinding[] {
	const { story, children, all, similar = [] } = input;
	const findings: ReviewFinding[] = [];
	const byId = new Map(all.map((s) => [s.id, s]));

	if (children.length > 0) {
		findings.push({
			severity: "blocker",
			message: `#${story.id} is an epic with ${children.length} child ${children.length === 1 ? "story" : "stories"}, not a unit of work. Epics are never handed out; review and start a child instead.`,
		});
	}

	const missing = story.depends_on.filter((id) => !byId.has(id));
	if (missing.length > 0) {
		findings.push({
			severity: "blocker",
			message: `depends_on references ${missing.map((id) => `#${id}`).join(", ")}, which ${missing.length === 1 ? "does" : "do"} not exist. Drop or correct the reference.`,
		});
	}

	const depCycle = findCycle(story.id, (id) => byId.get(id)?.depends_on ?? []);
	if (depCycle) {
		findings.push({
			severity: "blocker",
			message: `dependency cycle: ${depCycle.map((id) => `#${id}`).join(" → ")}. Nothing in this cycle can ever start — break it before working.`,
		});
	}

	const nextCycle = findCycle(story.id, (id) => {
		const next = byId.get(id)?.next_id;
		return next == null ? [] : [next];
	});
	if (nextCycle) {
		findings.push({
			severity: "blocker",
			message: `next_id cycle: ${nextCycle.map((id) => `#${id}`).join(" → ")}. Closing any of these would promote the chain forever.`,
		});
	}

	const deadDeps = story.depends_on
		.map((id) => byId.get(id))
		.filter((dep): dep is Story => !!dep && (dep.status === "cancelled" || dep.status === "archived"));
	if (deadDeps.length > 0) {
		findings.push({
			severity: "note",
			message: `depends on ${deadDeps.map((s) => `#${s.id} (${s.status})`).join(", ")} — a dependency that is not \`done\` never unblocks this story.`,
		});
	}

	if (story.proposed_changes.trim().length < MIN_PROPOSED_CHANGES) {
		findings.push({
			severity: "note",
			message: "proposed_changes is empty or too short to act on. Say which files or behaviour change.",
		});
	}

	if (story.parent_id === null) {
		findings.push({
			severity: "note",
			message: "no parent — this story belongs to no epic, so it will not be committed to an epic branch or close one.",
		});
	}

	const dupes = similar.filter((s) => s.id !== story.id);
	if (dupes.length > 0) {
		findings.push({
			severity: "note",
			message: `possible overlap with ${dupes.map((s) => `#${s.id} ${s.title}`).join("; ")}. Consider \`simplify\` if this duplicates them.`,
		});
	}

	return findings;
}

/** What the working tree holds, and what `verify` made of it. */
export interface WorkReviewInput {
	story: Story;
	/** From `changeStats` — the files a commit would sweep up. */
	changedFiles: string[];
	totalBytes: number;
	/** Null when `.pi/epic.json` declares no `verify` command. */
	verify: { command: string; ok: boolean; output: string } | null;
	maxFiles?: number;
	maxBytes?: number;
}

/** Mechanical findings on the work a story produced — does it deserve to close? */
export function reviewWork(input: WorkReviewInput): ReviewFinding[] {
	const findings: ReviewFinding[] = [];

	if (input.verify && !input.verify.ok) {
		findings.push({
			severity: "blocker",
			message: `verify failed (\`${input.verify.command}\`):\n${input.verify.output.trim().slice(-2000)}`,
		});
	}

	if (input.changedFiles.length === 0) {
		findings.push({
			severity: "note",
			message: "the working tree is clean — this story changed nothing. If that is right, close it as obsolete or wontfix rather than completed.",
		});
	}

	const size = checkStageSize({
		fileCount: input.changedFiles.length,
		totalBytes: input.totalBytes,
		maxFiles: input.maxFiles,
		maxBytes: input.maxBytes,
	});
	if (!size.ok) {
		findings.push({
			severity: "blocker",
			message: `${size.reason}. The commit would be refused; split the story or remove what does not belong.`,
		});
	}

	return findings;
}

export type UndoStrategy =
	| { kind: "reset"; to: string }
	| { kind: "revert"; sha: string }
	| { kind: "none"; reason: string };

/**
 * Resetting is only safe while the story's commit is still the tip; anything
 * later would be thrown away silently. Off the tip, revert leaves history intact.
 */
export function chooseUndoStrategy(record: StoryCommit | null, headSha: string | null): UndoStrategy {
	if (!record) return { kind: "none", reason: "no commit recorded for that story" };
	if (!record.commit_sha) {
		return { kind: "none", reason: "story closed without changes — nothing to undo" };
	}
	if (headSha && record.commit_sha === headSha) {
		return { kind: "reset", to: record.start_commit };
	}
	return { kind: "revert", sha: record.commit_sha };
}

/**
 * `git add -A` honours .gitignore but will happily stage an untracked secret or
 * a large artifact, so a story's commit is bounded before it is made.
 */
export interface StageGuardInput {
	fileCount: number;
	totalBytes: number;
	maxFiles?: number;
	maxBytes?: number;
}

export function checkStageSize(input: StageGuardInput): CheckResult {
	const maxFiles = input.maxFiles ?? 500;
	const maxBytes = input.maxBytes ?? 50 * 1024 * 1024;
	if (input.fileCount > maxFiles) {
		return { ok: false, reason: `${input.fileCount} changed files exceeds the limit of ${maxFiles}` };
	}
	if (input.totalBytes > maxBytes) {
		const mb = (input.totalBytes / (1024 * 1024)).toFixed(1);
		return { ok: false, reason: `${mb} MB of changes exceeds the limit of ${maxBytes / (1024 * 1024)} MB` };
	}
	return { ok: true };
}

/** `refs/pi/checkpoint/<epic>/<ms>` — one per turn that ended with a dirty tree. */
export function checkpointRefPrefix(epicId: number): string {
	return `refs/pi/checkpoint/${epicId}`;
}

/**
 * Which checkpoint refs to delete, keeping the newest `keep`.
 *
 * A long epic writes one ref per turn and nothing used to remove them, so
 * hundreds accumulated under a single prefix. Sorted by the millisecond suffix
 * rather than by name: the names are fixed-width today, but a ref written before
 * 2001 or after 2286 would not be, and sorting on the number costs nothing.
 * Anything without a numeric suffix sorts oldest and is pruned first.
 */
export function refsToPrune(refnames: string[], keep: number): string[] {
	if (keep < 0) return [];
	const stamp = (ref: string) => {
		const parsed = Number(ref.slice(ref.lastIndexOf("/") + 1));
		return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
	};
	return [...refnames].sort((a, b) => stamp(b) - stamp(a)).slice(keep);
}

/** Commands that would move the epic out from under the agent. Blocked while one is active. */
export function isBranchEscapingCommand(command: string): boolean {
	const normalized = command.trim().replace(/\s+/g, " ");
	return [
		/\bgit\s+switch\b(?!.*\s-c\b)/,
		/\bgit\s+checkout\s+(?!--\s)(?!-b\b)[^\s-]/,
		/\bgit\s+reset\s+--hard\b/,
		/\bgit\s+branch\s+-D\b/,
		/\bgit\s+worktree\s+remove\b/,
	].some((pattern) => pattern.test(normalized));
}
