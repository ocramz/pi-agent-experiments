import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readManifest, resolvePaths } from "../src/config.ts";
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
