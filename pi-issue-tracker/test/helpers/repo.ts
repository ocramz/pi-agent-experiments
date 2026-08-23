import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolvePaths } from "../../src/config.ts";
import type {
	GitResult,
	GitRunner,
	ReviewReply,
	ReviewRequest,
	ReviewerRunner,
	ShellRunner,
	TrackerContext,
} from "../../src/context.ts";
import { openDb } from "../../src/database.ts";
import { createLocalGitRunner, createLocalShellRunner } from "../../src/git.ts";
import { keywordStrategy } from "../../src/related.ts";

/**
 * A throwaway git repository plus a wired TrackerContext.
 *
 * Git config is redirected into the temp directory, so no test ever reads or
 * writes the developer's real ~/.gitconfig — without that, a global
 * `commit.gpgsign` or a custom `init.defaultBranch` would make results depend
 * on whose machine they ran on.
 */
/**
 * A clock the test drives.
 *
 * Timestamps are written by the caller through `ctx.now`, so ordering between
 * two epics is only testable if a test can put a known gap between them. Real
 * time cannot: two rows created in the same millisecond tie, and the tie-break
 * is rowid.
 */
export interface TestClock {
	now(): number;
	advance(ms: number): void;
	set(value: number): void;
}

export interface TempRepo {
	dir: string;
	git: GitRunner;
	shell: ShellRunner;
	db: DatabaseSync;
	ctx: TrackerContext;
	clock: TestClock;
	/** Commit everything currently in the tree. Returns the new sha. */
	commit(message: string): Promise<string>;
	write(relativePath: string, contents: string): void;
	sha(ref?: string): Promise<string>;
	cleanup(): void;
}

export async function createTempRepo(
	opts: { branch?: string; initialCommit?: boolean } = {},
): Promise<TempRepo> {
	const branch = opts.branch ?? "feat/test";
	// realpath, because on macOS `tmpdir()` is /var/... which is a symlink to
	// /private/var/.... git always reports the resolved path, so without this
	// every comparison between a path we constructed and one git printed fails —
	// in the tests, and in `resolveSessionEpic`, which matches a worktree row by
	// string equality against `rev-parse --show-toplevel`.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-tracker-")));

	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: dir,
		GIT_CONFIG_GLOBAL: join(dir, ".gitconfig"),
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
	};
	const git = createLocalGitRunner({ cwd: dir, env });
	const shell = createLocalShellRunner({ cwd: dir, env });

	const must = async (args: string[]): Promise<GitResult> => {
		const result = await git(args);
		if (result.code !== 0) {
			throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);
		}
		return result;
	};

	await must(["init", "--quiet", "."]);
	if (opts.initialCommit !== false) {
		writeFileSync(join(dir, "README.md"), "# fixture\n");
		await must(["add", "-A"]);
		await must(["commit", "--quiet", "-m", "initial"]);
		await must(["switch", "--quiet", "-c", branch]);
	}

	const paths = await resolvePaths({ cwd: dir, git, overrides: { repoRoot: dir }, env: {} });
	const db = openDb(paths.dbPath);

	let time = 1_700_000_000_000;
	const clock: TestClock = {
		now: () => time,
		advance: (ms) => {
			time += ms;
		},
		set: (value) => {
			time = value;
		},
	};

	return {
		dir,
		git,
		shell,
		db,
		clock,
		ctx: {
			paths,
			db,
			git,
			shell,
			related: keywordStrategy,
			now: clock.now,
			notify: () => {},
		},
		write(relativePath, contents) {
			writeFileSync(join(dir, relativePath), contents);
		},
		async commit(message) {
			await must(["add", "-A"]);
			await must(["commit", "--quiet", "-m", message]);
			return (await must(["rev-parse", "HEAD"])).stdout.trim();
		},
		async sha(ref = "HEAD") {
			return (await must(["rev-parse", ref])).stdout.trim();
		},
		cleanup() {
			try {
				db.close();
			} catch {
				// Already closed by the test.
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/**
 * A GitRunner that runs nothing and records what it was asked to do.
 *
 * Lets a test assert the *shape* of a git interaction — that `--ff-only` is used,
 * that a backup ref is written first — without a repository at all.
 */
export function createRecordingGitRunner(
	responses: (args: string[]) => Partial<GitResult> | undefined = () => undefined,
): GitRunner & { calls: string[][] } {
	const calls: string[][] = [];
	const runner = (async (args: string[]) => {
		calls.push(args);
		const canned = responses(args) ?? {};
		return { stdout: "", stderr: "", code: 0, ...canned };
	}) as GitRunner & { calls: string[][] };
	runner.calls = calls;
	return runner;
}

/**
 * A reviewer that answers from a script instead of calling a model.
 *
 * The independent-review path is the part of this extension most expensive to
 * exercise for real — a second model call per review — and least deterministic.
 * With this, every branch of it (approve, request changes, unparseable prose,
 * transport failure) runs in the unit tier for free, and the live tier only has
 * to prove the wiring.
 */
export function createStubReviewer(
	reply: ReviewReply | ((req: ReviewRequest) => ReviewReply | Promise<ReviewReply>),
): ReviewerRunner & { calls: ReviewRequest[] } {
	const calls: ReviewRequest[] = [];
	const runner = (async (req: ReviewRequest) => {
		calls.push(req);
		return typeof reply === "function" ? await reply(req) : reply;
	}) as ReviewerRunner & { calls: ReviewRequest[] };
	runner.calls = calls;
	return runner;
}

/** A reviewer returning a well-formed verdict, as the real one would. */
export function stubVerdict(
	verdict: "approved" | "changes_requested",
	findings = "looks fine",
	model = "stub/reviewer-1",
): ReviewerRunner & { calls: ReviewRequest[] } {
	return createStubReviewer({ ok: true, model, text: JSON.stringify({ verdict, findings }) });
}
