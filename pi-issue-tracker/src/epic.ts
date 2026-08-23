import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { readManifest, type EpicManifest } from "./config.ts";
import type { TrackerContext } from "./context.ts";
import {
	createEpicBranch,
	getEpicBranch,
	getStoryById,
	getStoryCommit,
	recordStoryCommit,
	recordStoryStart,
	updateEpicBranch,
} from "./database.ts";
import {
	changeStats,
	currentBranch,
	findConflicts,
	isDirty,
	revParse,
	writeBackupRef,
} from "./git.ts";
import {
	backupRefName,
	checkStageSize,
	chooseUndoStrategy,
	epicBranchName,
	storyCommitMessage,
	type CheckResult,
} from "./rules.ts";
import type { EpicBranch, EpicMode, Story } from "./types.ts";

/**
 * The epic lifecycle: start, commit each story, update from the base branch,
 * merge back, cancel, undo.
 *
 * Every function takes a TrackerContext and performs through its injected
 * runners, so the whole file is exercised against a temp repository with no pi
 * runtime. Decisions live in rules.ts; this file only acts on them.
 */

export interface Outcome {
	ok: boolean;
	/** One line for the user or the agent. Always populated. */
	note: string;
}

/** Where an epic's git commands run: its worktree if it has one, else the main repo. */
export function epicCwd(ctx: TrackerContext, epic: EpicBranch): string {
	return epic.path ?? ctx.paths.repoRoot;
}

/** Nearest ancestor (or self) that has an epic branch recorded. */
export function findEpicForStory(ctx: TrackerContext, storyId: number): EpicBranch | null {
	const seen = new Set<number>();
	let cursor: number | null = storyId;
	while (cursor !== null && !seen.has(cursor)) {
		seen.add(cursor);
		const epic = getEpicBranch(ctx.db, cursor);
		if (epic && epic.state === "active") return epic;
		cursor = getStoryById(ctx.db, cursor)?.parent_id ?? null;
	}
	return null;
}

function hashSetup(setup: string | undefined): string {
	return createHash("sha256").update(setup ?? "").digest("hex").slice(0, 16);
}

/**
 * Make sure the tracker's own database is ignored before any story is committed.
 *
 * stories.db sits at `<repo>/.pi/stories.db` by default, so unless it is ignored
 * every `git add -A` sweeps the tracker's own binary state into the story's
 * commit — and a dirty tree then blocks the merge as well. Relying on the user
 * having added it to .gitignore is too fragile for something the extension
 * itself creates.
 *
 * `.git/info/exclude` is the right place: it is repo-local, is not itself
 * tracked, and so needs no commit and shows up in nobody's diff.
 */
export async function ensureDatabaseIgnored(ctx: TrackerContext): Promise<void> {
	const relativePath = relative(ctx.paths.repoRoot, ctx.paths.dbPath);
	// Outside the repository (a test or an explicit override) — nothing to ignore.
	if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return;

	const ignored = await ctx.git(["check-ignore", "--quiet", relativePath], { cwd: ctx.paths.repoRoot });
	if (ignored.code === 0) return;

	const commonDir = await ctx.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
		cwd: ctx.paths.repoRoot,
	});
	if (commonDir.code !== 0) return;

	// The -wal and -shm siblings appear because the database runs in WAL mode.
	const patterns = [relativePath, `${relativePath}-wal`, `${relativePath}-shm`];
	const excludeFile = join(commonDir.stdout.trim(), "info", "exclude");
	try {
		mkdirSync(dirname(excludeFile), { recursive: true });
		const existing = existsSync(excludeFile) ? readFileSync(excludeFile, "utf-8") : "";
		const missing = patterns.filter((pattern) => !existing.split("\n").includes(pattern));
		if (missing.length === 0) return;
		const separator = existing.length && !existing.endsWith("\n") ? "\n" : "";
		appendFileSync(excludeFile, `${separator}# pi-issue-tracker state\n${missing.join("\n")}\n`);
	} catch {
		// A read-only .git is unusual but survivable: the size guard and the
		// user's own .gitignore are still in play.
	}
}

/** Point the manifest's declared cache variables at one shared directory. */
function cacheEnv(manifest: EpicManifest, sharedRoot: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of manifest.caches ?? []) env[name] = sharedRoot;
	return env;
}

// ─── Setup ──────────────────────────────────────────────────────────

/**
 * Run the manifest's setup command, once per epic.
 *
 * Re-runs only when the command itself changed, so a story that adds a
 * dependency to the manifest gets a fresh install while ordinary stories pay
 * nothing. The command, its exit code and the tool versions it ran against are
 * recorded, which is what makes "does this environment still match?" answerable.
 */
export async function runSetup(
	ctx: TrackerContext,
	epic: EpicBranch,
	manifest: EpicManifest = readManifest(ctx.paths.manifestPath),
): Promise<Outcome> {
	if (!manifest.setup) return { ok: true, note: "" };

	const hash = hashSetup(manifest.setup);
	if (epic.setup.hash === hash && epic.setup.exit_code === 0) {
		return { ok: true, note: "setup already up to date" };
	}

	const cwd = epicCwd(ctx, epic);
	const env = cacheEnv(manifest, `${ctx.paths.worktreeRoot}/.caches`);
	const result = await ctx.shell(manifest.setup, { cwd, env });

	let versions = "";
	if (manifest.versions) {
		const probed = await ctx.shell(manifest.versions, { cwd, env });
		versions = probed.stdout.trim();
	}

	updateEpicBranch(ctx.db, epic.epic_id, {
		setup: { hash, exit_code: result.code, versions, ran_at: ctx.now() },
	});

	return result.code === 0
		? { ok: true, note: "setup completed" }
		: { ok: false, note: `setup failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 400)}` };
}

// ─── Start ──────────────────────────────────────────────────────────

export interface StartEpicOptions {
	story: Story;
	mode?: EpicMode;
	/** Commit a dirty tree as the epic's first commit instead of refusing. */
	carryDirty?: boolean;
	/** Worktree mode only. */
	path?: string | null;
}

/**
 * Create the epic's branch and record it.
 *
 * Preconditions are checked by the caller through `checkCanStartEpic`; this
 * function performs. A backup ref is written before the branch is created so
 * that even "start" has an inverse.
 */
export async function startEpic(
	ctx: TrackerContext,
	opts: StartEpicOptions,
): Promise<Outcome & { epic?: EpicBranch }> {
	const { story, mode = "branch", carryDirty = false } = opts;
	const cwd = ctx.paths.repoRoot;

	// Before anything is committed, so the tracker never commits its own database.
	await ensureDatabaseIgnored(ctx);

	const baseBranch = await currentBranch(ctx.git, cwd);
	if (!baseBranch) return { ok: false, note: "HEAD is detached — check out a branch first" };

	const baseCommit = await revParse(ctx.git, "HEAD", cwd);
	if (!baseCommit) return { ok: false, note: "the repository has no commits yet" };

	await writeBackupRef(ctx.git, backupRefName(story.id, "pre-start"), baseCommit, cwd);

	const branch = epicBranchName(story);
	const created = await ctx.git(["switch", "--quiet", "-c", branch], { cwd });
	if (created.code !== 0) {
		return { ok: false, note: `could not create ${branch}: ${created.stderr.trim()}` };
	}

	// Carrying a dirty tree keeps the user's in-flight work rather than making
	// them stash it by hand — the branch switch above brought it along.
	let carried = "";
	if (carryDirty && (await isDirty(ctx.git, cwd))) {
		await ctx.git(["add", "-A"], { cwd });
		const committed = await ctx.git(
			["commit", "--quiet", "-m", `story(#${story.id}): carry uncommitted changes into ${branch}`],
			{ cwd },
		);
		if (committed.code === 0) carried = " (existing changes carried into the first commit)";
	}

	const epic = createEpicBranch(ctx.db, {
		epic_id: story.id,
		mode,
		branch,
		base_branch: baseBranch,
		base_commit: baseCommit,
		path: opts.path ?? null,
	});

	const setup = await runSetup(ctx, epic);
	const refreshed = getEpicBranch(ctx.db, story.id) ?? epic;

	return {
		ok: setup.ok,
		epic: refreshed,
		note: `epic #${story.id} started on ${branch} (from ${baseBranch})${carried}${setup.note ? ` — ${setup.note}` : ""}`,
	};
}

// ─── Per-story commits ──────────────────────────────────────────────

/** Remember where a story began, so undoing it has a target. */
export async function recordStoryStartCommit(
	ctx: TrackerContext,
	story: Story,
	epic: EpicBranch,
): Promise<void> {
	const head = await revParse(ctx.git, "HEAD", epicCwd(ctx, epic));
	if (head) recordStoryStart(ctx.db, story.id, epic.epic_id, head);
}

/**
 * Commit everything a story changed, as one commit.
 *
 * A clean tree is reported, not treated as an error: plenty of stories are
 * research or review and legitimately change nothing. The size guard runs
 * before staging — `git add -A` honours .gitignore but will happily commit an
 * untracked credentials file or a stray model checkpoint.
 */
export async function commitStory(
	ctx: TrackerContext,
	story: Story,
	epic: EpicBranch,
	manifest: EpicManifest = readManifest(ctx.paths.manifestPath),
): Promise<Outcome & { sha?: string }> {
	const cwd = epicCwd(ctx, epic);

	const stats = await changeStats(ctx.git, cwd);
	if (stats.files.length === 0) {
		return { ok: true, note: `story #${story.id}: nothing to commit` };
	}

	const guard: CheckResult = checkStageSize({
		fileCount: stats.files.length,
		totalBytes: stats.totalBytes,
	});
	if (!guard.ok) {
		return {
			ok: false,
			note: `story #${story.id}: refusing to commit — ${guard.reason}. Commit deliberately, or add the unwanted paths to .gitignore.`,
		};
	}

	if (manifest.verify) {
		const verified = await ctx.shell(manifest.verify, { cwd });
		if (verified.code !== 0) {
			return {
				ok: false,
				note: `story #${story.id}: verify failed (exit ${verified.code}), nothing committed:\n${(verified.stdout || verified.stderr).trim().slice(0, 800)}`,
			};
		}
	}

	const before = await revParse(ctx.git, "HEAD", cwd);
	if (before) {
		await writeBackupRef(ctx.git, backupRefName(epic.epic_id, `pre-story-${story.id}`), before, cwd);
	}

	const staged = await ctx.git(["add", "-A"], { cwd });
	if (staged.code !== 0) return { ok: false, note: `story #${story.id}: git add failed: ${staged.stderr.trim()}` };

	const message = storyCommitMessage(story);
	const args = ["commit", "--quiet", "-m", message.subject];
	if (message.body) args.push("-m", message.body);
	const committed = await ctx.git(args, { cwd });
	if (committed.code !== 0) {
		return { ok: false, note: `story #${story.id}: commit failed: ${(committed.stderr || committed.stdout).trim()}` };
	}

	const sha = await revParse(ctx.git, "HEAD", cwd);
	recordStoryCommit(ctx.db, story.id, {
		commit_sha: sha,
		backup_ref: before ? backupRefName(epic.epic_id, `pre-story-${story.id}`) : null,
	});

	return {
		ok: true,
		sha: sha ?? undefined,
		note: `story #${story.id}: committed ${stats.files.length} file(s) as ${sha?.slice(0, 8)}`,
	};
}

// ─── Merging ────────────────────────────────────────────────────────

/**
 * Step 1 — bring the base branch into the epic branch.
 *
 * Done in this direction on purpose: conflicts surface in the directory the
 * agent is working in, where it can resolve them. It also makes step 2 a
 * fast-forward, which cannot fail partway through.
 */
export async function updateFromBase(
	ctx: TrackerContext,
	epic: EpicBranch,
): Promise<Outcome & { conflicts: string[] }> {
	const cwd = epicCwd(ctx, epic);

	const behind = await ctx.git(["rev-list", "--count", `${epic.branch}..${epic.base_branch}`], { cwd });
	if (behind.code === 0 && behind.stdout.trim() === "0") {
		return { ok: true, conflicts: [], note: `already up to date with ${epic.base_branch}` };
	}

	const head = await revParse(ctx.git, "HEAD", cwd);
	if (head) await writeBackupRef(ctx.git, backupRefName(epic.epic_id, "pre-update"), head, cwd);

	const merged = await ctx.git(
		["merge", "--no-ff", "-m", `Merge ${epic.base_branch} into ${epic.branch}`, epic.base_branch],
		{ cwd },
	);
	if (merged.code === 0) {
		return { ok: true, conflicts: [], note: `updated ${epic.branch} from ${epic.base_branch}` };
	}

	const conflicts = await findConflicts(ctx.git, cwd);
	return {
		ok: false,
		conflicts,
		note: conflicts.length
			? `merging ${epic.base_branch} into ${epic.branch} conflicts in ${conflicts.length} file(s): ${conflicts.join(", ")}`
			: `merging ${epic.base_branch} into ${epic.branch} failed: ${(merged.stderr || merged.stdout).trim()}`,
	};
}

/**
 * Step 2 — fast-forward the base branch onto the epic branch.
 *
 * `--ff-only` is the point: after step 1 the base branch is an ancestor, so this
 * cannot conflict and cannot leave the user's branch half-merged. A backup ref
 * is written first, which is what makes `undoMerge` a one-liner.
 */
export async function mergeIntoBase(
	ctx: TrackerContext,
	epic: EpicBranch,
): Promise<Outcome & { backupRef?: string }> {
	const cwd = ctx.paths.repoRoot;

	if (await isDirty(ctx.git, cwd)) {
		return { ok: false, note: `${ctx.paths.repoRoot} has uncommitted changes — commit or stash them first` };
	}

	// The base branch has to be the checked-out branch for the merge to land.
	const onBranch = await currentBranch(ctx.git, cwd);
	if (onBranch !== epic.base_branch) {
		const switched = await ctx.git(["switch", "--quiet", epic.base_branch], { cwd });
		if (switched.code !== 0) {
			return { ok: false, note: `could not switch to ${epic.base_branch}: ${switched.stderr.trim()}` };
		}
	}

	const backupRef = backupRefName(epic.epic_id, "pre-merge");
	const baseHead = await revParse(ctx.git, "HEAD", cwd);
	if (baseHead) await writeBackupRef(ctx.git, backupRef, baseHead, cwd);

	const merged = await ctx.git(["merge", "--ff-only", epic.branch], { cwd });
	if (merged.code !== 0) {
		return {
			ok: false,
			note: `fast-forward of ${epic.base_branch} failed — ${epic.base_branch} has moved. Update the epic from it first, then merge again.`,
		};
	}

	updateEpicBranch(ctx.db, epic.epic_id, { state: "merged" });
	return {
		ok: true,
		backupRef,
		note: `merged ${epic.branch} into ${epic.base_branch}. Undo with the recorded backup ref ${backupRef}.`,
	};
}

/** Stop working on an epic without merging. The branch is kept, so this is reversible. */
export async function cancelEpic(
	ctx: TrackerContext,
	epic: EpicBranch,
	opts: { deleteBranch?: boolean } = {},
): Promise<Outcome> {
	const cwd = ctx.paths.repoRoot;

	const tip = await revParse(ctx.git, epic.branch, cwd);
	if (tip) await writeBackupRef(ctx.git, backupRefName(epic.epic_id, "pre-cancel"), tip, cwd);

	if (await isDirty(ctx.git, cwd)) {
		return { ok: false, note: "working tree has uncommitted changes — commit or stash them first" };
	}

	const switched = await ctx.git(["switch", "--quiet", epic.base_branch], { cwd });
	if (switched.code !== 0) {
		return { ok: false, note: `could not switch back to ${epic.base_branch}: ${switched.stderr.trim()}` };
	}

	let deleted = "";
	if (opts.deleteBranch) {
		// -D rather than -d: the branch is deliberately unmerged, and its tip is
		// held by the backup ref written above.
		const removed = await ctx.git(["branch", "-D", epic.branch], { cwd });
		deleted = removed.code === 0 ? `, branch ${epic.branch} deleted` : "";
	}

	updateEpicBranch(ctx.db, epic.epic_id, { state: "cancelled" });
	return {
		ok: true,
		note: `epic #${epic.epic_id} cancelled, back on ${epic.base_branch}${deleted}. Its work is still reachable at ${backupRefName(epic.epic_id, "pre-cancel")}.`,
	};
}

// ─── Undo ───────────────────────────────────────────────────────────

/**
 * Reverse one story's commit.
 *
 * Resets only while that commit is still the tip; anything newer would be
 * discarded silently, so off the tip it reverts instead.
 */
export async function undoStory(
	ctx: TrackerContext,
	storyId: number,
	epic: EpicBranch,
): Promise<Outcome> {
	const cwd = epicCwd(ctx, epic);
	const record = getStoryCommit(ctx.db, storyId);
	const head = await revParse(ctx.git, "HEAD", cwd);
	const strategy = chooseUndoStrategy(record, head);

	if (strategy.kind === "none") return { ok: false, note: `story #${storyId}: ${strategy.reason}` };

	if (head) await writeBackupRef(ctx.git, backupRefName(epic.epic_id, `pre-undo-${storyId}`), head, cwd);

	if (strategy.kind === "reset") {
		const reset = await ctx.git(["reset", "--hard", strategy.to], { cwd });
		if (reset.code !== 0) return { ok: false, note: `reset failed: ${reset.stderr.trim()}` };
		recordStoryCommit(ctx.db, storyId, { commit_sha: null });
		return {
			ok: true,
			note: `story #${storyId} reset to ${strategy.to.slice(0, 8)}. The discarded work is still at ${backupRefName(epic.epic_id, `pre-undo-${storyId}`)}.`,
		};
	}

	const reverted = await ctx.git(["revert", "--no-edit", strategy.sha], { cwd });
	if (reverted.code !== 0) {
		const conflicts = await findConflicts(ctx.git, cwd);
		return {
			ok: false,
			note: conflicts.length
				? `reverting story #${storyId} conflicts in: ${conflicts.join(", ")}`
				: `revert failed: ${(reverted.stderr || reverted.stdout).trim()}`,
		};
	}
	return { ok: true, note: `story #${storyId} reverted (its commit is kept in history).` };
}

/** Put the base branch back exactly where it was before `mergeIntoBase`. */
export async function undoMerge(ctx: TrackerContext, epic: EpicBranch): Promise<Outcome> {
	const cwd = ctx.paths.repoRoot;
	const ref = backupRefName(epic.epic_id, "pre-merge");

	const target = await revParse(ctx.git, ref, cwd);
	if (!target) return { ok: false, note: `no merge backup found at ${ref} — nothing to undo` };

	if (await isDirty(ctx.git, cwd)) {
		return { ok: false, note: "working tree has uncommitted changes — commit or stash them first" };
	}

	const onBranch = await currentBranch(ctx.git, cwd);
	if (onBranch !== epic.base_branch) {
		const switched = await ctx.git(["switch", "--quiet", epic.base_branch], { cwd });
		if (switched.code !== 0) {
			return { ok: false, note: `could not switch to ${epic.base_branch}: ${switched.stderr.trim()}` };
		}
	}

	const reset = await ctx.git(["reset", "--hard", target], { cwd });
	if (reset.code !== 0) return { ok: false, note: `reset failed: ${reset.stderr.trim()}` };

	updateEpicBranch(ctx.db, epic.epic_id, { state: "active" });
	return {
		ok: true,
		note: `${epic.base_branch} restored to ${target.slice(0, 8)}; epic #${epic.epic_id} is active again.`,
	};
}
