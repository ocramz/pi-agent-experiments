import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { GitResult, GitRunner, TrackerContext } from "./context.ts";
import { getActiveEpicBranches, updateEpicBranch } from "./database.ts";
import type { EpicBranch } from "./types.ts";

/**
 * Git worktree plumbing, and the reconciliation that keeps the database honest
 * about which worktrees still exist.
 *
 * Same contract as src/git.ts: everything goes through an injected `GitRunner`
 * and nothing throws — a non-zero `code` is the only error signal.
 *
 * A worktree is *filesystem* isolation layered on top of the branch. It is what
 * makes concurrent epics possible: each one gets its own directory and its own
 * pi session, while `resolveRepoRoot`'s use of `--git-common-dir` keeps them all
 * reading and writing one `stories.db`.
 */

export interface WorktreeEntry {
	/** Absolute path, as git reports it. */
	path: string;
	head: string | null;
	/** Short branch name, or null when the worktree has a detached HEAD. */
	branch: string | null;
	detached: boolean;
	/** A worktree whose directory has gone missing under git's feet. */
	prunable: boolean;
}

/**
 * `git worktree list --porcelain` output.
 *
 * The format is stanzas separated by blank lines, each opening with a
 * `worktree <path>` line. Parsing the porcelain form rather than the human one
 * matters: the default output pads columns and truncates nothing, but it also
 * writes the branch as `[name]` and gives no stable way to tell a detached HEAD
 * from a branch literally named `detached`.
 */
export async function listWorktrees(git: GitRunner, cwd: string): Promise<WorktreeEntry[]> {
	const result = await git(["worktree", "list", "--porcelain"], { cwd });
	if (result.code !== 0) return [];

	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | null = null;

	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current) entries.push(current);
			current = { path: line.slice("worktree ".length), head: null, branch: null, detached: false, prunable: false };
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
		else if (line.startsWith("branch ")) {
			// Always the full refname, e.g. `refs/heads/epic/3-thing`. The branch
			// name itself can contain slashes, so only the prefix may be stripped.
			const ref = line.slice("branch ".length);
			current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
		} else if (line === "detached") current.detached = true;
		else if (line.startsWith("prunable")) current.prunable = true;
	}
	if (current) entries.push(current);
	return entries;
}

/**
 * Create `path` as a linked worktree with a new branch off `base`.
 *
 * The parent directory is created first: `worktree add` will make the leaf but
 * not the chain above it, and `worktreeRoot` defaults outside the repository, so
 * on a first epic that chain does not exist yet.
 */
export async function addWorktree(
	git: GitRunner,
	opts: { cwd: string; path: string; branch: string; base: string },
): Promise<GitResult> {
	mkdirSync(dirname(opts.path), { recursive: true });
	return git(["worktree", "add", "--quiet", "-b", opts.branch, opts.path, opts.base], { cwd: opts.cwd });
}

/**
 * Remove a worktree and its administrative entry.
 *
 * `--force` is needed for a worktree carrying untracked or modified files.
 * Callers decide: after a successful merge the tree is clean and plain `remove`
 * is the honest default, because a refusal there means something unexpected is
 * in the directory and deleting it silently would be wrong.
 */
export async function removeWorktree(
	git: GitRunner,
	cwd: string,
	path: string,
	opts: { force?: boolean } = {},
): Promise<GitResult> {
	const args = ["worktree", "remove"];
	if (opts.force) args.push("--force");
	args.push(path);
	return git(args, { cwd });
}

/** Drop administrative entries for worktrees whose directories are gone. */
export async function pruneWorktrees(git: GitRunner, cwd: string): Promise<GitResult> {
	return git(["worktree", "prune"], { cwd });
}

/**
 * Which working tree currently has `branch` checked out, if any.
 *
 * `mergeIntoBase` needs this: git refuses to move a branch that is checked out
 * somewhere, and with concurrent epics "somewhere" may be another session's
 * worktree rather than the main checkout.
 */
export async function branchCheckoutLocation(
	git: GitRunner,
	cwd: string,
	branch: string,
): Promise<string | null> {
	const entries = await listWorktrees(git, cwd);
	return entries.find((entry) => entry.branch === branch)?.path ?? null;
}

/**
 * Copy the manifest's `copy` entries into a fresh worktree.
 *
 * A worktree is a checkout, so it carries tracked files and nothing else. The
 * gitignored ones a build actually needs — `.env`, a local settings file — have
 * to be brought over by hand or setup fails in ways that look like the
 * manifest's fault.
 *
 * Entries are repo-relative and are refused if they point outside it: the
 * manifest is a checked-in file, and one that could copy `/etc/shadow` into a
 * worktree would be a way to make a repository attack whoever opens it.
 */
export function copyManifestFiles(
	from: string,
	to: string,
	entries: string[] | undefined,
): { copied: string[]; skipped: string[] } {
	const copied: string[] = [];
	const skipped: string[] = [];

	for (const entry of entries ?? []) {
		if (isAbsolute(entry)) {
			skipped.push(entry);
			continue;
		}
		const source = resolve(from, entry);
		const within = relative(from, source);
		if (!within || within.startsWith("..")) {
			skipped.push(entry);
			continue;
		}
		if (!existsSync(source)) {
			skipped.push(entry);
			continue;
		}
		const target = join(to, within);
		try {
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(source, target);
			copied.push(within);
		} catch {
			skipped.push(entry);
		}
	}
	return { copied, skipped };
}

export interface WorktreeReconciliation {
	/** Active epics whose worktree directory is no longer registered. */
	missing: EpicBranch[];
	/** Registered worktrees under our root that no active epic claims. */
	orphaned: WorktreeEntry[];
}

/**
 * Compare what the database believes against what git reports.
 *
 * Pure, taking both lists, so the interesting part — the classification — is
 * tested without a repository. Two things drift: a crashed session or a manual
 * `rm -rf` leaves a row pointing at nothing, and a cancelled epic whose removal
 * failed leaves a directory nobody owns.
 *
 * Only paths under `worktreeRoot` count as orphans. A worktree the user created
 * for their own reasons is none of the tracker's business.
 */
export function findMissingWorktrees(
	epics: EpicBranch[],
	entries: WorktreeEntry[],
	worktreeRoot: string,
): WorktreeReconciliation {
	const live = new Set(entries.filter((entry) => !entry.prunable).map((entry) => entry.path));
	const claimed = new Set<string>();

	const missing: EpicBranch[] = [];
	for (const epic of epics) {
		if (epic.state !== "active" || epic.mode !== "worktree" || !epic.path) continue;
		if (live.has(epic.path)) claimed.add(epic.path);
		else missing.push(epic);
	}

	const orphaned = entries.filter((entry) => {
		if (claimed.has(entry.path)) return false;
		const within = relative(worktreeRoot, entry.path);
		return Boolean(within) && !within.startsWith("..") && !isAbsolute(within);
	});

	return { missing, orphaned };
}

/**
 * What reconciling the database against git turned up.
 *
 * `cancelled` rows have already been written; `orphaned` directories have not
 * been touched. That asymmetry is the point — see `reconcileWorktrees`.
 */
export interface ReconcileReport {
	cancelled: EpicBranch[];
	orphaned: WorktreeEntry[];
}

/**
 * Reconcile what the database believes about worktrees against what git says.
 *
 * A crashed session or a manual `rm -rf` leaves an active row pointing at a
 * directory that is gone; a failed removal leaves a directory no epic claims.
 * The first is bookkeeping and is fixed silently — the epic's branch and its
 * backup refs are untouched, so nothing is lost by marking the row cancelled.
 *
 * The second is only *reported*. Deleting a directory is not a decision to make
 * on the user's behalf during startup, and a blocking dialog there would stall
 * every session behind a question most of them do not need to answer. So this
 * returns what it found and the caller decides how to say it.
 */
export async function reconcileWorktrees(ctx: TrackerContext): Promise<ReconcileReport> {
	const entries = await listWorktrees(ctx.git, ctx.paths.repoRoot);
	const { missing, orphaned } = findMissingWorktrees(
		getActiveEpicBranches(ctx.db),
		entries,
		ctx.paths.worktreeRoot,
	);

	const cancelled: EpicBranch[] = [];
	for (const epic of missing) {
		updateEpicBranch(ctx.db, epic.epic_id, { state: "cancelled", path: null }, ctx.now());
		cancelled.push(epic);
	}
	return { cancelled, orphaned };
}
