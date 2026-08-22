import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { GitResult, GitRunner } from "./context.ts";

/**
 * Git plumbing. Every call goes through a `GitRunner` so the caller decides
 * whether that is `pi.exec` or a local child process — see src/context.ts.
 *
 * Nothing here throws on a failed command: a non-zero `code` is the only error
 * signal, which is what `pi.exec` gives us and what the shipped git examples
 * branch on.
 */

/** A `GitRunner` backed by `child_process.execFile`. Used by tests and any non-pi caller. */
export function createLocalGitRunner(
	defaults: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): GitRunner {
	return (args, opts) =>
		new Promise<GitResult>((done) => {
			execFile(
				"git",
				args,
				{
					cwd: opts?.cwd ?? defaults.cwd,
					timeout: opts?.timeout ?? 0,
					env: defaults.env ?? process.env,
					maxBuffer: 32 * 1024 * 1024,
				},
				(err, stdout, stderr) => {
					// A missing binary (err.code === "ENOENT") and a non-zero exit both
					// have to surface the same way, or the two runners would diverge.
					const raw = (err as NodeJS.ErrnoException & { code?: number | string } | null)?.code;
					const code = err ? (typeof raw === "number" ? raw : 1) : 0;
					done({ stdout: stdout ?? "", stderr: stderr ?? "", code });
				},
			);
		});
}

export interface RepoInfo {
	isRepo: boolean;
	/** Main working tree, even when called from inside a linked worktree. */
	repoRoot: string | null;
	/** Null when HEAD is detached. */
	branch: string | null;
	head: string | null;
	dirty: boolean;
}

const trim = (r: GitResult) => r.stdout.trim();

/**
 * The main working tree, resolved from the *common* git dir.
 *
 * `--git-dir` inside a linked worktree points at `<main>/.git/worktrees/<name>`;
 * `--git-common-dir` points at `<main>/.git`. Using the common one is what keeps
 * every worktree resolving to the same stories.db instead of silently opening an
 * empty one of its own.
 */
export async function resolveRepoRoot(git: GitRunner, cwd: string): Promise<string | null> {
	// --path-format needs git 2.31+; fall back to resolving the relative form
	// ourselves, since older git returns a bare ".git" in the main worktree.
	const absolute = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
	const raw = absolute.code === 0
		? trim(absolute)
		: trim(await git(["rev-parse", "--git-common-dir"], { cwd }));
	if (!raw) return null;

	const gitDir = isAbsolute(raw) ? raw : resolve(cwd, raw);
	// <root>/.git -> <root>. A bare repo has no working tree to return.
	return gitDir.endsWith("/.git") ? gitDir.slice(0, -"/.git".length) : null;
}

/** Null when HEAD is detached, which `rev-parse --abbrev-ref` would report as "HEAD". */
export async function currentBranch(git: GitRunner, cwd: string): Promise<string | null> {
	const result = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd });
	return result.code === 0 ? trim(result) || null : null;
}

export async function isDirty(git: GitRunner, cwd: string): Promise<boolean> {
	const result = await git(["status", "--porcelain"], { cwd });
	return result.code === 0 && trim(result).length > 0;
}

export async function revParse(git: GitRunner, ref: string, cwd: string): Promise<string | null> {
	const result = await git(["rev-parse", "--verify", "--quiet", ref], { cwd });
	return result.code === 0 ? trim(result) || null : null;
}

export async function probeRepo(git: GitRunner, cwd: string): Promise<RepoInfo> {
	const repoRoot = await resolveRepoRoot(git, cwd);
	if (!repoRoot) {
		return { isRepo: false, repoRoot: null, branch: null, head: null, dirty: false };
	}
	const [branch, head, dirty] = await Promise.all([
		currentBranch(git, cwd),
		revParse(git, "HEAD", cwd),
		isDirty(git, cwd),
	]);
	return { isRepo: true, repoRoot, branch, head, dirty };
}

/**
 * Point a ref at `sha` so the commit stays reachable.
 *
 * Written before every destructive operation. Costs 41 bytes and is the reason
 * every command in this extension has an inverse.
 */
export async function writeBackupRef(
	git: GitRunner,
	ref: string,
	sha: string,
	cwd: string,
): Promise<boolean> {
	const result = await git(["update-ref", ref, sha], { cwd });
	return result.code === 0;
}

export async function listBackupRefs(git: GitRunner, prefix: string, cwd: string): Promise<string[]> {
	const result = await git(["for-each-ref", "--format=%(refname)", prefix], { cwd });
	return result.code === 0 ? trim(result).split("\n").filter(Boolean) : [];
}

/** Paths left unmerged by a conflicting merge, for handing back to the agent. */
export async function findConflicts(git: GitRunner, cwd: string): Promise<string[]> {
	const result = await git(["diff", "--name-only", "--diff-filter=U"], { cwd });
	return result.code === 0 ? trim(result).split("\n").filter(Boolean) : [];
}
