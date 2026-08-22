import type { Story, StoryCommit } from "./types.ts";

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

export interface StartEpicInput {
	isRepo: boolean;
	/** Null when HEAD is detached. */
	branch: string | null;
	dirty: boolean;
	story: Story | null;
	/** A unit of work has none; an epic has children. */
	childCount: number;
	/** Set when another epic is already running in branch mode. */
	activeEpicId: number | null;
	/** True once the user has agreed to carry a dirty tree onto the epic branch. */
	carryDirty?: boolean;
}

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
	if (input.activeEpicId !== null && input.activeEpicId !== input.story.id) {
		return {
			ok: false,
			reason: `epic #${input.activeEpicId} is still active — merge or cancel it first`,
		};
	}
	// Dirty is recoverable rather than fatal: refusing outright is what makes
	// people work around the tool. The caller offers to carry the changes.
	if (input.dirty && !input.carryDirty) {
		return { ok: false, reason: "working tree has uncommitted changes" };
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
	return {
		subject: `story(#${story.id}): ${story.title}${resolution}`,
		body: bodyLines.join("\n\n"),
	};
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
