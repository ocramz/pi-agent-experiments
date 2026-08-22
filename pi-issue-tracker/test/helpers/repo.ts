import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolvePaths } from "../../src/config.ts";
import type { GitResult, GitRunner, TrackerContext } from "../../src/context.ts";
import { openDb } from "../../src/database.ts";
import { createLocalGitRunner } from "../../src/git.ts";
import { keywordStrategy } from "../../src/related.ts";

/**
 * A throwaway git repository plus a wired TrackerContext.
 *
 * Git config is redirected into the temp directory, so no test ever reads or
 * writes the developer's real ~/.gitconfig — without that, a global
 * `commit.gpgsign` or a custom `init.defaultBranch` would make results depend
 * on whose machine they ran on.
 */
export interface TempRepo {
	dir: string;
	git: GitRunner;
	db: DatabaseSync;
	ctx: TrackerContext;
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
	const dir = mkdtempSync(join(tmpdir(), "pi-tracker-"));

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

	return {
		dir,
		git,
		db,
		ctx: {
			paths,
			db,
			git,
			related: keywordStrategy,
			now: () => 1_700_000_000_000,
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
