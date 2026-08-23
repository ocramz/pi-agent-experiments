import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { readManifest, type EpicManifest } from "./config.ts";
import type { GitRunner, TrackerContext } from "./context.ts";
import {
	createEpicBranch,
	getActiveBranchModeEpic,
	getEpicBranch,
	getEpicBranchByPath,
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
	listBackupRefs,
	revParse,
	writeBackupRef,
} from "./git.ts";
import {
	backupRefName,
	checkStageSize,
	checkpointRefPrefix,
	chooseUndoStrategy,
	epicBranchName,
	refsToPrune,
	storyCommitMessage,
	worktreeDirName,
	type CheckResult,
} from "./rules.ts";
import type { EpicBranch, EpicMode, Story } from "./types.ts";
import { addWorktree, branchCheckoutLocation, copyManifestFiles, removeWorktree } from "./worktree.ts";

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

/**
 * Where an epic's git commands run: its worktree if it has one, else the main repo.
 *
 * `path` is non-null exactly while the worktree exists — it is cleared when the
 * worktree is removed, so a merged or cancelled epic falls back to the main
 * repository and `undoStory` against it still works.
 */
export function epicCwd(ctx: TrackerContext, epic: EpicBranch): string {
	return epic.path ?? ctx.paths.repoRoot;
}

/** The top of the working tree containing `cwd` — the *linked* one, not the main repo. */
export async function worktreeTopLevel(git: GitRunner, cwd: string): Promise<string | null> {
	const result = await git(["rev-parse", "--show-toplevel"], { cwd });
	return result.code === 0 ? result.stdout.trim() || null : null;
}

/**
 * The epic this session owns, resolved from where the session is standing.
 *
 * With concurrent epics there is no such thing as "the" active epic: several run
 * at once, each in its own worktree and its own pi session. A session inside a
 * linked worktree owns whatever epic claims that directory; a session in the
 * main checkout owns the branch-mode epic, of which there is at most one.
 *
 * Deliberately *not* resolved by current branch. The design lets the user wander
 * off the epic branch mid-epic — that is why `base_branch` is recorded at start
 * rather than read at merge time — and branch-based resolution would lose the
 * epic the moment they did.
 */
export async function resolveSessionEpic(
	ctx: TrackerContext,
	cwd: string,
): Promise<EpicBranch | null> {
	const top = await worktreeTopLevel(ctx.git, cwd);
	if (top && top !== ctx.paths.repoRoot) {
		const epic = getEpicBranchByPath(ctx.db, top);
		return epic && epic.state === "active" ? epic : null;
	}
	return getActiveBranchModeEpic(ctx.db);
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

	updateEpicBranch(
		ctx.db,
		epic.epic_id,
		{ setup: { hash, exit_code: result.code, versions, ran_at: ctx.now() } },
		ctx.now(),
	);

	return result.code === 0
		? { ok: true, note: "setup completed" }
		: { ok: false, note: `setup failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 400)}` };
}

// ─── Start ──────────────────────────────────────────────────────────

export interface StartEpicOptions {
	story: Story;
	mode?: EpicMode;
	/** Commit a dirty tree as the epic's first commit instead of refusing. Branch mode only. */
	carryDirty?: boolean;
	/** Worktree mode: overrides the derived `<worktreeRoot>/<worktreeDirName>`. */
	path?: string | null;
}

/** Where a worktree epic's directory goes, unless the caller names one. */
export function epicWorktreePath(ctx: TrackerContext, story: Story): string {
	return join(ctx.paths.worktreeRoot, worktreeDirName(story));
}

/**
 * Create the epic's branch and record it.
 *
 * Preconditions are checked by the caller through `checkCanStartEpic`; this
 * function performs. A backup ref is written before the branch is created so
 * that even "start" has an inverse.
 *
 * The two modes diverge on one question: does the main checkout move? In branch
 * mode it does — `git switch -c` — and that is why only one branch-mode epic can
 * exist. In worktree mode nothing about the main checkout changes, which is what
 * makes concurrent epics possible.
 */
export async function startEpic(
	ctx: TrackerContext,
	opts: StartEpicOptions,
): Promise<Outcome & { epic?: EpicBranch }> {
	const { story, mode = "branch", carryDirty = false } = opts;
	const cwd = ctx.paths.repoRoot;

	// Before anything is committed, so the tracker never commits its own database.
	// `.git/info/exclude` lives in the common git dir, so one write covers every
	// worktree.
	await ensureDatabaseIgnored(ctx);

	const baseBranch = await currentBranch(ctx.git, cwd);
	if (!baseBranch) return { ok: false, note: "HEAD is detached — check out a branch first" };

	const baseCommit = await revParse(ctx.git, "HEAD", cwd);
	if (!baseCommit) return { ok: false, note: "the repository has no commits yet" };

	await writeBackupRef(ctx.git, backupRefName(story.id, "pre-start"), baseCommit, cwd);

	const branch = epicBranchName(story);
	const manifest = readManifest(ctx.paths.manifestPath);

	let path: string | null = null;
	let located = "";

	if (mode === "worktree") {
		path = opts.path ?? epicWorktreePath(ctx, story);
		const added = await addWorktree(ctx.git, { cwd, path, branch, base: baseBranch });
		if (added.code !== 0) {
			return { ok: false, note: `could not create a worktree at ${path}: ${(added.stderr || added.stdout).trim()}` };
		}

		// Store the path git resolved, not the one we asked for. `resolveSessionEpic`
		// looks the row up by string equality against `rev-parse --show-toplevel`,
		// and git reports the real path — so a worktree root reached through a
		// symlink (every /tmp on macOS) would never match what we wrote.
		path = (await worktreeTopLevel(ctx.git, path)) ?? path;

		// A worktree is a checkout: it carries tracked files and nothing else.
		// Whatever the manifest declares under `copy` — .env and friends — has to
		// be brought over or setup fails for reasons that look like its fault.
		const { copied, skipped } = copyManifestFiles(cwd, path, manifest.copy);
		located = ` in ${path}`;
		if (copied.length) located += ` (copied ${copied.join(", ")})`;
		if (skipped.length) located += ` (could not copy ${skipped.join(", ")})`;
	} else {
		const created = await ctx.git(["switch", "--quiet", "-c", branch], { cwd });
		if (created.code !== 0) {
			return { ok: false, note: `could not create ${branch}: ${created.stderr.trim()}` };
		}

		// Carrying a dirty tree keeps the user's in-flight work rather than making
		// them stash it by hand — the branch switch above brought it along.
		if (carryDirty && (await isDirty(ctx.git, cwd))) {
			await ctx.git(["add", "-A"], { cwd });
			const committed = await ctx.git(
				["commit", "--quiet", "-m", `story(#${story.id}): carry uncommitted changes into ${branch}`],
				{ cwd },
			);
			if (committed.code === 0) located = " (existing changes carried into the first commit)";
		}
	}

	const epic = createEpicBranch(
		ctx.db,
		{
			epic_id: story.id,
			mode,
			branch,
			base_branch: baseBranch,
			base_commit: baseCommit,
			path,
		},
		ctx.now(),
	);

	const setup = await runSetup(ctx, epic, manifest);
	const refreshed = getEpicBranch(ctx.db, story.id) ?? epic;

	return {
		ok: setup.ok,
		epic: refreshed,
		note: `epic #${story.id} started on ${branch} (from ${baseBranch})${located}${setup.note ? ` — ${setup.note}` : ""}`,
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
	if (head) recordStoryStart(ctx.db, story.id, epic.epic_id, head, ctx.now());
}

/**
 * Commit everything a story changed, as one commit.
 *
 * A clean tree is reported, not treated as an error: plenty of stories are
 * research or review and legitimately change nothing. The size guard runs
 * before staging — `git add -A` honours .gitignore but will happily commit an
 * untracked credentials file or a stray model checkpoint.
 */
/**
 * Gather what a work review needs to judge: the pending changes, and whether
 * the manifest's `verify` passes.
 *
 * Runs `verify` at *review* time as well as at commit time. Duplicated work, but
 * a `verify` failure discovered here is reported as a finding the agent can act
 * on, where the same failure inside `commitStory` only aborts the close with a
 * note — and by then the agent has already decided it was finished.
 */
export async function collectWorkEvidence(
	ctx: TrackerContext,
	epic: EpicBranch,
	manifest: EpicManifest = readManifest(ctx.paths.manifestPath),
): Promise<{
	changedFiles: string[];
	totalBytes: number;
	verify: { command: string; ok: boolean; output: string } | null;
}> {
	const cwd = epicCwd(ctx, epic);
	const stats = await changeStats(ctx.git, cwd);

	let verify: { command: string; ok: boolean; output: string } | null = null;
	if (manifest.verify) {
		const ran = await ctx.shell(manifest.verify, { cwd });
		verify = {
			command: manifest.verify,
			ok: ran.code === 0,
			output: ran.stdout || ran.stderr,
		};
	}

	return { changedFiles: stats.files, totalBytes: stats.totalBytes, verify };
}

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
 *
 * Two ways to move the branch. The working-tree way — check out the base branch
 * and `merge --ff-only` — is right whenever the main checkout should end up
 * showing the merged result: always in branch mode, where the user has been
 * sitting on the epic branch and expects to come back, and in worktree mode when
 * the main checkout already happens to be on the base branch.
 *
 * Otherwise the ref is moved directly, under a compare-and-swap. Checking the
 * base branch out just to merge it would drag a session somewhere it did not ask
 * to go, and with concurrent epics that session belongs to somebody else.
 * `checkCanMerge` has already refused the third case, where another worktree
 * holds the base branch.
 */
export async function mergeIntoBase(
	ctx: TrackerContext,
	epic: EpicBranch,
): Promise<Outcome & { backupRef?: string }> {
	const cwd = ctx.paths.repoRoot;
	const backupRef = backupRefName(epic.epic_id, "pre-merge");

	const holder = await branchCheckoutLocation(ctx.git, cwd, epic.base_branch);
	if (holder && holder !== cwd) {
		return {
			ok: false,
			note: `${epic.base_branch} is checked out in ${holder} — finish or move that worktree before merging.`,
		};
	}

	const baseHead = await revParse(ctx.git, epic.base_branch, cwd);
	if (!baseHead) return { ok: false, note: `${epic.base_branch} no longer exists` };
	const epicTip = await revParse(ctx.git, epic.branch, cwd);
	if (!epicTip) return { ok: false, note: `${epic.branch} no longer exists` };

	await writeBackupRef(ctx.git, backupRef, baseHead, cwd);

	// Branch mode always lands in the working tree: the user started the epic
	// from this checkout and the merge is what brings them home.
	const inWorkingTree = epic.mode === "branch" || holder === cwd;

	if (inWorkingTree) {
		if (await isDirty(ctx.git, cwd)) {
			return { ok: false, note: `${cwd} has uncommitted changes — commit or stash them first` };
		}
		if (holder !== cwd) {
			const switched = await ctx.git(["switch", "--quiet", epic.base_branch], { cwd });
			if (switched.code !== 0) {
				return { ok: false, note: `could not switch to ${epic.base_branch}: ${switched.stderr.trim()}` };
			}
		}
		const merged = await ctx.git(["merge", "--ff-only", epic.branch], { cwd });
		if (merged.code !== 0) {
			return {
				ok: false,
				note: `fast-forward of ${epic.base_branch} failed — ${epic.base_branch} has moved. Update the epic from it first, then merge again.`,
			};
		}
	} else {
		// Nobody has the base branch checked out, so no working tree can go stale.
		// Ancestry is checked explicitly because `update-ref` would happily move
		// the branch sideways; the CAS on `baseHead` closes the window between the
		// check and the write.
		const ancestor = await ctx.git(["merge-base", "--is-ancestor", epic.base_branch, epic.branch], { cwd });
		if (ancestor.code !== 0) {
			return {
				ok: false,
				note: `fast-forward of ${epic.base_branch} failed — ${epic.base_branch} has moved. Update the epic from it first, then merge again.`,
			};
		}
		const moved = await ctx.git(["update-ref", `refs/heads/${epic.base_branch}`, epicTip, baseHead], { cwd });
		if (moved.code !== 0) {
			return {
				ok: false,
				note: `could not move ${epic.base_branch}: ${(moved.stderr || moved.stdout).trim()}`,
			};
		}
	}

	updateEpicBranch(ctx.db, epic.epic_id, { state: "merged" }, ctx.now());
	return {
		ok: true,
		backupRef,
		note: `merged ${epic.branch} into ${epic.base_branch}. Undo with the recorded backup ref ${backupRef}.`,
	};
}

/**
 * Take down an epic's worktree and clear the row's `path`.
 *
 * Split out because both `/merge-epic` and `/cancel-epic` need it, and both need
 * it to happen *after* the session standing in that directory has moved out.
 * Clearing `path` maintains the invariant `epicCwd` depends on: a row points at
 * a directory only while that directory exists.
 */
export async function releaseWorktree(
	ctx: TrackerContext,
	epic: EpicBranch,
	opts: { force?: boolean } = {},
): Promise<Outcome> {
	if (epic.mode !== "worktree" || !epic.path) return { ok: true, note: "" };

	const removed = await removeWorktree(ctx.git, ctx.paths.repoRoot, epic.path, opts);
	if (removed.code !== 0) {
		return {
			ok: false,
			note: `could not remove the worktree at ${epic.path}: ${(removed.stderr || removed.stdout).trim()}`,
		};
	}
	updateEpicBranch(ctx.db, epic.epic_id, { path: null }, ctx.now());
	return { ok: true, note: `removed the worktree at ${epic.path}` };
}

/**
 * Stop working on an epic without merging. The branch is kept, so this is reversible.
 *
 * Branch mode has to move the main checkout back off the epic branch. Worktree
 * mode must not touch it at all — the main checkout was never moved, and another
 * session may be sitting in it.
 */
export async function cancelEpic(
	ctx: TrackerContext,
	epic: EpicBranch,
	opts: { deleteBranch?: boolean; force?: boolean } = {},
): Promise<Outcome> {
	const cwd = ctx.paths.repoRoot;

	const tip = await revParse(ctx.git, epic.branch, cwd);
	if (tip) await writeBackupRef(ctx.git, backupRefName(epic.epic_id, "pre-cancel"), tip, cwd);

	let where: string;
	if (epic.mode === "worktree") {
		// Removing the worktree is what frees the branch: git refuses `branch -D`
		// while a working tree has it checked out.
		const released = await releaseWorktree(ctx, epic, { force: opts.force });
		if (!released.ok) return released;
		where = `the main checkout is untouched, ${released.note}`;
	} else {
		if (await isDirty(ctx.git, cwd)) {
			return { ok: false, note: "working tree has uncommitted changes — commit or stash them first" };
		}
		const switched = await ctx.git(["switch", "--quiet", epic.base_branch], { cwd });
		if (switched.code !== 0) {
			return { ok: false, note: `could not switch back to ${epic.base_branch}: ${switched.stderr.trim()}` };
		}
		where = `back on ${epic.base_branch}`;
	}

	let deleted = "";
	if (opts.deleteBranch) {
		// -D rather than -d: the branch is deliberately unmerged, and its tip is
		// held by the backup ref written above.
		const removed = await ctx.git(["branch", "-D", epic.branch], { cwd });
		deleted = removed.code === 0 ? `, branch ${epic.branch} deleted` : "";
	}

	updateEpicBranch(ctx.db, epic.epic_id, { state: "cancelled" }, ctx.now());
	return {
		ok: true,
		note: `epic #${epic.epic_id} cancelled, ${where}${deleted}. Its work is still reachable at ${backupRefName(epic.epic_id, "pre-cancel")}.`,
	};
}

// ─── Ref hygiene ────────────────────────────────────────────────────

/**
 * Keep the newest `keep` checkpoints for an epic and delete the rest.
 *
 * `turn_end` writes one ref per turn that ended with a dirty tree, so an epic
 * that runs for a day leaves hundreds. They cost 41 bytes each and keep their
 * stash commits alive, which is the point — but only for as long as anybody
 * might reach for them, and `/undo-turn` only ever reads the newest.
 */
export async function pruneCheckpoints(
	ctx: TrackerContext,
	epic: EpicBranch,
	keep = 20,
): Promise<number> {
	const cwd = epicCwd(ctx, epic);
	const refs = await listBackupRefs(ctx.git, checkpointRefPrefix(epic.epic_id), cwd);
	const doomed = refsToPrune(refs, keep);
	for (const ref of doomed) await ctx.git(["update-ref", "-d", ref], { cwd });
	return doomed.length;
}

/**
 * Delete an epic's backup refs, except the operations named in `keep`.
 *
 * Backup refs are the safety net that gives every command an inverse, so they
 * are never pruned automatically — only when the user asks, at merge or cancel,
 * and never the one that command's own undo depends on (`pre-merge` for
 * `/undo-merge`, `pre-cancel` for the work an abandoned epic left behind).
 */
export async function pruneEpicRefs(
	ctx: TrackerContext,
	epicId: number,
	keepOperations: string[] = [],
): Promise<number> {
	const cwd = ctx.paths.repoRoot;
	const keep = new Set(keepOperations.map((operation) => backupRefName(epicId, operation)));
	const refs = [
		...(await listBackupRefs(ctx.git, `refs/pi/backup/${epicId}`, cwd)),
		...(await listBackupRefs(ctx.git, checkpointRefPrefix(epicId), cwd)),
	];

	let deleted = 0;
	for (const ref of refs) {
		if (keep.has(ref)) continue;
		const removed = await ctx.git(["update-ref", "-d", ref], { cwd });
		if (removed.code === 0) deleted++;
	}
	return deleted;
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

/**
 * Put the base branch back exactly where it was before `mergeIntoBase`.
 *
 * Mirrors that function's two paths for the same reason: reset the working tree
 * when the main checkout is on the base branch, and move the ref directly when
 * nothing has it checked out, rather than dragging a session onto a branch it
 * was not on.
 */
export async function undoMerge(ctx: TrackerContext, epic: EpicBranch): Promise<Outcome> {
	const cwd = ctx.paths.repoRoot;
	const ref = backupRefName(epic.epic_id, "pre-merge");

	const target = await revParse(ctx.git, ref, cwd);
	if (!target) return { ok: false, note: `no merge backup found at ${ref} — nothing to undo` };

	const holder = await branchCheckoutLocation(ctx.git, cwd, epic.base_branch);
	if (holder && holder !== cwd) {
		return {
			ok: false,
			note: `${epic.base_branch} is checked out in ${holder} — undo the merge from there, or remove that worktree first.`,
		};
	}

	if (holder === cwd) {
		if (await isDirty(ctx.git, cwd)) {
			return { ok: false, note: "working tree has uncommitted changes — commit or stash them first" };
		}
		const reset = await ctx.git(["reset", "--hard", target], { cwd });
		if (reset.code !== 0) return { ok: false, note: `reset failed: ${reset.stderr.trim()}` };
	} else {
		const moved = await ctx.git(["update-ref", `refs/heads/${epic.base_branch}`, target], { cwd });
		if (moved.code !== 0) {
			return { ok: false, note: `could not move ${epic.base_branch}: ${(moved.stderr || moved.stdout).trim()}` };
		}
	}

	updateEpicBranch(ctx.db, epic.epic_id, { state: "active" }, ctx.now());
	return {
		ok: true,
		note: `${epic.base_branch} restored to ${target.slice(0, 8)}; epic #${epic.epic_id} is active again.`,
	};
}
