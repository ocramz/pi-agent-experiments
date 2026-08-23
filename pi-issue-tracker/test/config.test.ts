import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { describeReviewerConfig, readManifest, resolvePaths, resolveReviewer } from "../src/config.ts";
import { resolveRepoRoot } from "../src/git.ts";
import { createTempRepo, type TempRepo } from "./helpers/repo.ts";

const repos: TempRepo[] = [];
async function repo(): Promise<TempRepo> {
	const created = await createTempRepo();
	repos.push(created);
	return created;
}
after(() => {
	for (const created of repos) created.cleanup();
});

describe("resolvePaths", () => {
	it("derives every path from the repository root", async () => {
		const r = await repo();
		const paths = await resolvePaths({ cwd: r.dir, git: r.git, env: {} });
		assert.equal(paths.repoRoot, r.dir);
		assert.equal(paths.dbPath, join(r.dir, ".pi", "stories.db"));
		assert.equal(paths.manifestPath, join(r.dir, ".pi", "epic.json"));
	});

	it("puts the worktree root outside the repository", async () => {
		const r = await repo();
		const paths = await resolvePaths({ cwd: r.dir, git: r.git, env: {} });
		assert.ok(
			!paths.worktreeRoot.startsWith(`${r.dir}/`),
			`worktreeRoot ${paths.worktreeRoot} must not sit inside the repo, or every rg and test glob descends into a second copy of the tree`,
		);
	});

	it("prefers overrides, then environment, then settings.json", async () => {
		const r = await repo();
		mkdirSync(join(r.dir, ".pi"), { recursive: true });
		writeFileSync(
			join(r.dir, ".pi", "settings.json"),
			JSON.stringify({ tracker: { dbPath: "from-settings.db" } }),
		);

		const fromSettings = await resolvePaths({ cwd: r.dir, git: r.git, env: {} });
		assert.equal(fromSettings.dbPath, join(r.dir, "from-settings.db"), "relative settings paths resolve against the repo root");

		const fromEnv = await resolvePaths({ cwd: r.dir, git: r.git, env: { PI_TRACKER_DB: "/tmp/from-env.db" } });
		assert.equal(fromEnv.dbPath, "/tmp/from-env.db");

		const fromOverride = await resolvePaths({
			cwd: r.dir,
			git: r.git,
			env: { PI_TRACKER_DB: "/tmp/from-env.db" },
			overrides: { dbPath: "/tmp/from-override.db" },
		});
		assert.equal(fromOverride.dbPath, "/tmp/from-override.db");
	});

	it("falls back to the working directory outside a repository", async () => {
		const r = await repo();
		const notARepo = join(r.dir, "..", "definitely-not-a-repo-" + process.pid);
		mkdirSync(notARepo, { recursive: true });
		const paths = await resolvePaths({ cwd: notARepo, git: r.git, env: {} });
		assert.equal(paths.repoRoot, notARepo);
	});
});

describe("worktree anchoring", () => {
	/**
	 * The regression this guards: `session_start` used to derive the database
	 * path from the current directory, so entering a worktree opened a fresh,
	 * empty stories.db and the epic vanished.
	 */
	it("resolves the main repository from inside a linked worktree", async () => {
		const r = await repo();
		const worktree = join(r.dir, "..", `wt-${process.pid}-${Date.now()}`);

		const added = await r.git(["worktree", "add", "--quiet", "-b", "epic/1-x", worktree, "HEAD"]);
		assert.equal(added.code, 0, `worktree add failed: ${added.stderr}`);

		try {
			const root = await resolveRepoRoot(r.git, worktree);
			assert.equal(root, r.dir, "a linked worktree must resolve to the MAIN working tree");

			const paths = await resolvePaths({ cwd: worktree, git: r.git, env: {} });
			assert.equal(
				paths.dbPath,
				join(r.dir, ".pi", "stories.db"),
				"the tracker database must stay in the main repo, shared by every worktree",
			);
		} finally {
			await r.git(["worktree", "remove", "--force", worktree]);
		}
	});
});

describe("readManifest", () => {
	it("reads a declared manifest", async () => {
		const r = await repo();
		mkdirSync(join(r.dir, ".pi"), { recursive: true });
		writeFileSync(
			join(r.dir, ".pi", "epic.json"),
			JSON.stringify({ setup: "npm ci", verify: "npm test", caches: ["npm_config_cache"] }),
		);
		const manifest = readManifest(join(r.dir, ".pi", "epic.json"));
		assert.equal(manifest.setup, "npm ci");
		assert.deepEqual(manifest.caches, ["npm_config_cache"]);
	});

	it("treats a missing or malformed manifest as empty rather than failing", async () => {
		const r = await repo();
		assert.deepEqual(readManifest(join(r.dir, "nope.json")), {});
		writeFileSync(join(r.dir, "bad.json"), "{not json");
		assert.deepEqual(readManifest(join(r.dir, "bad.json")), {});
	});
});

describe("resolveReviewer", () => {
	const settings = (dir: string, tracker: Record<string, unknown>) => {
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ tracker }));
	};

	// Off by default: two extra model calls per story is not a cost to impose
	// without being asked for it.
	it("returns null when nothing is configured — self-review is the default", async () => {
		const r = await repo();
		assert.equal(resolveReviewer({ repoRoot: r.dir, env: {} }), null);
	});

	it("reads both halves from settings.json", async () => {
		const r = await repo();
		settings(r.dir, { reviewProvider: "openrouter", reviewModel: "anthropic/claude-sonnet-5" });
		assert.deepEqual(resolveReviewer({ repoRoot: r.dir, env: {} }), {
			provider: "openrouter",
			modelId: "anthropic/claude-sonnet-5",
		});
	});

	it("lets the environment beat settings.json", async () => {
		const r = await repo();
		settings(r.dir, { reviewProvider: "openrouter", reviewModel: "from-settings" });
		const choice = resolveReviewer({
			repoRoot: r.dir,
			env: { PI_TRACKER_REVIEW_MODEL: "from-env" },
		});
		assert.equal(choice?.modelId, "from-env");
		assert.equal(choice?.provider, "openrouter", "the unset half still falls through");
	});

	it("lets explicit overrides beat the environment", async () => {
		const r = await repo();
		const choice = resolveReviewer({
			repoRoot: r.dir,
			overrides: { reviewProvider: "a", reviewModel: "b" },
			env: { PI_TRACKER_REVIEW_PROVIDER: "x", PI_TRACKER_REVIEW_MODEL: "y" },
		});
		assert.deepEqual(choice, { provider: "a", modelId: "b" });
	});

	it("needs both halves — a provider alone is not a reviewer", async () => {
		const r = await repo();
		assert.equal(resolveReviewer({ repoRoot: r.dir, env: { PI_TRACKER_REVIEW_PROVIDER: "openrouter" } }), null);
	});

	it("treats a blank value as unset", async () => {
		const r = await repo();
		settings(r.dir, { reviewProvider: "  ", reviewModel: "  " });
		assert.equal(resolveReviewer({ repoRoot: r.dir, env: {} }), null);
	});
});

describe("describeReviewerConfig", () => {
	it("is content with nothing configured", async () => {
		const r = await repo();
		assert.deepEqual(describeReviewerConfig({ repoRoot: r.dir, env: {} }), { ok: true });
	});

	it("is content with both halves", async () => {
		const r = await repo();
		const env = { PI_TRACKER_REVIEW_PROVIDER: "openrouter", PI_TRACKER_REVIEW_MODEL: "m" };
		assert.deepEqual(describeReviewerConfig({ repoRoot: r.dir, env }), { ok: true });
	});

	/**
	 * A half-configured reviewer must not quietly become self-review: the user
	 * asked for an independent one and would otherwise never find out.
	 */
	it("names the missing half rather than silently falling back", async () => {
		const r = await repo();
		const result = describeReviewerConfig({ repoRoot: r.dir, env: { PI_TRACKER_REVIEW_PROVIDER: "openrouter" } });
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.reason : "", /PI_TRACKER_REVIEW_MODEL is not set/);
	});

	it("names the other missing half too", async () => {
		const r = await repo();
		const result = describeReviewerConfig({ repoRoot: r.dir, env: { PI_TRACKER_REVIEW_MODEL: "m" } });
		assert.match(result.ok === false ? result.reason : "", /PI_TRACKER_REVIEW_PROVIDER is not set/);
	});
});
