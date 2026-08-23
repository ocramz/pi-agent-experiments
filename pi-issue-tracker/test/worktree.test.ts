import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { resolvePaths } from "../src/config.ts";
import { createStory, getEpicBranch, getEpicBranchByPath } from "../src/database.ts";
import {
	cancelEpic,
	commitStory,
	epicWorktreePath,
	mergeIntoBase,
	pruneCheckpoints,
	pruneEpicRefs,
	resolveSessionEpic,
	startEpic,
	undoMerge,
} from "../src/epic.ts";
import { currentBranch, listBackupRefs, revParse } from "../src/git.ts";
import { backupRefName, checkpointRefPrefix } from "../src/rules.ts";
import type { EpicBranch, Story } from "../src/types.ts";
import {
	branchCheckoutLocation,
	copyManifestFiles,
	findMissingWorktrees,
	listWorktrees,
	type WorktreeEntry,
} from "../src/worktree.ts";
import { createTempRepo, type TempRepo } from "./helpers/repo.ts";

/**
 * Worktree mode, which is what makes concurrent epics possible.
 *
 * Everything here runs against real `git worktree` in a temp repository. The
 * cheap parts — porcelain parsing, reconciliation — are exercised as pure
 * functions too, because a classification bug is much easier to read as a table
 * than as a repository state.
 */

const repos: TempRepo[] = [];
async function repo(): Promise<TempRepo> {
	const created = await createTempRepo();
	repos.push(created);
	return created;
}
after(() => {
	// Worktrees are registered inside the repo's own .git, and both live under
	// the same temp directory, so removing the repo takes them with it.
	for (const created of repos) created.cleanup();
});

function makeStory(r: TempRepo, fields: Partial<Story> & { title: string }): Story {
	return createStory(r.db, {
		title: fields.title,
		sub_goal: fields.sub_goal ?? "do the thing",
		proposed_changes: fields.proposed_changes ?? "",
		status: fields.status ?? "ready",
		priority: fields.priority ?? 0,
		parent_id: fields.parent_id ?? null,
		next_id: null,
		depends_on: [],
	});
}

/** An epic with one child story, started in a worktree of its own. */
async function startedWorktreeEpic(r: TempRepo, title = "Add auth") {
	const epicStory = makeStory(r, { title });
	const child = makeStory(r, { title: `${title} — step one`, parent_id: epicStory.id });
	const started = await startEpic(r.ctx, { story: epicStory, mode: "worktree" });
	assert.ok(started.ok && started.epic, started.note);
	return { epicStory, child, epic: started.epic };
}

/** Write a file inside a worktree and close a story against it. */
async function closeStory(r: TempRepo, epic: EpicBranch, story: Story, file: string, contents: string) {
	writeFileSync(join(epic.path ?? r.dir, file), contents);
	return commitStory(r.ctx, story, epic);
}

describe("startEpic --worktree", () => {
	it("creates a worktree outside the repository and records it", async () => {
		const r = await repo();
		const { epicStory, epic } = await startedWorktreeEpic(r);

		assert.equal(epic.mode, "worktree");
		assert.ok(epic.path, "a worktree epic must record where it lives");
		assert.ok(existsSync(epic.path!), `${epic.path} should exist`);
		assert.equal(
			epic.path,
			epicWorktreePath(r.ctx, epicStory),
			"the derived path is what the command shows the user before creating it",
		);
		assert.ok(
			!epic.path!.startsWith(`${r.dir}/`),
			"a worktree under the repo makes every rg, tsc and test glob descend into a second copy of the tree",
		);
	});

	it("leaves the main checkout exactly where it was", async () => {
		const r = await repo();
		const before = await currentBranch(r.git, r.dir);
		const headBefore = await r.sha("HEAD");

		const { epic } = await startedWorktreeEpic(r);

		assert.equal(await currentBranch(r.git, r.dir), before, "the main checkout must not move");
		assert.equal(await r.sha("HEAD"), headBefore);
		assert.equal(epic.base_branch, before);
	});

	it("checks the epic branch out in the worktree, not in the main repo", async () => {
		const r = await repo();
		const { epic } = await startedWorktreeEpic(r);

		assert.equal(await currentBranch(r.git, epic.path!), epic.branch);
		assert.equal(await branchCheckoutLocation(r.git, r.dir, epic.branch), epic.path);
	});

	it("starts from a dirty main tree without carrying or refusing anything", async () => {
		const r = await repo();
		r.write("in-flight.txt", "not committed\n");

		const { epic } = await startedWorktreeEpic(r);

		assert.ok(epic.path);
		assert.ok(
			existsSync(join(r.dir, "in-flight.txt")),
			"the uncommitted file stays in the main tree, untouched",
		);
		assert.ok(
			!existsSync(join(epic.path!, "in-flight.txt")),
			"and does not leak into the worktree, which is a checkout of the base branch",
		);
	});

	it("carries the manifest's copy entries into the worktree", async () => {
		const r = await repo();
		writeFileSync(join(r.dir, ".env"), "SECRET=1\n");
		mkdirSync(join(r.dir, "config"), { recursive: true });
		writeFileSync(join(r.dir, "config", "local.json"), "{}\n");
		mkdirSync(join(r.dir, ".pi"), { recursive: true });
		writeFileSync(
			r.ctx.paths.manifestPath,
			JSON.stringify({ copy: [".env", "config/local.json", "absent.txt"] }),
		);

		const { epic } = await startedWorktreeEpic(r);

		assert.equal(readFileSync(join(epic.path!, ".env"), "utf-8"), "SECRET=1\n");
		assert.equal(
			readFileSync(join(epic.path!, "config", "local.json"), "utf-8"),
			"{}\n",
			"nested copy targets need their parent directory created",
		);
		assert.ok(!existsSync(join(epic.path!, "absent.txt")), "a declared file that does not exist is skipped");
	});

	it("runs the manifest's setup command inside the worktree", async () => {
		const r = await repo();
		mkdirSync(join(r.dir, ".pi"), { recursive: true });
		writeFileSync(r.ctx.paths.manifestPath, JSON.stringify({ setup: "pwd > where-setup-ran.txt" }));

		const { epic } = await startedWorktreeEpic(r);

		const where = readFileSync(join(epic.path!, "where-setup-ran.txt"), "utf-8").trim();
		assert.equal(where, epic.path, "setup must run in the worktree, not in the main checkout");
	});
});

describe("concurrent epics", () => {
	/**
	 * The whole point of the mode. Two epics, two worktrees, one database — and
	 * neither one's commits appear on the other's branch.
	 */
	it("keeps two worktree epics from interfering", async () => {
		const r = await repo();
		const a = await startedWorktreeEpic(r, "Alpha");
		const b = await startedWorktreeEpic(r, "Beta");

		assert.notEqual(a.epic.path, b.epic.path);
		assert.notEqual(a.epic.branch, b.epic.branch);

		const first = await closeStory(r, a.epic, a.child, "alpha.txt", "a\n");
		const second = await closeStory(r, b.epic, b.child, "beta.txt", "b\n");
		assert.ok(first.ok, first.note);
		assert.ok(second.ok, second.note);

		const alphaFiles = (await r.git(["ls-tree", "--name-only", a.epic.branch])).stdout;
		const betaFiles = (await r.git(["ls-tree", "--name-only", b.epic.branch])).stdout;
		assert.match(alphaFiles, /alpha\.txt/);
		assert.doesNotMatch(alphaFiles, /beta\.txt/, "Beta's commit must not land on Alpha's branch");
		assert.match(betaFiles, /beta\.txt/);
		assert.doesNotMatch(betaFiles, /alpha\.txt/);

		// One commit each, both off the same base.
		assert.equal((await r.git(["rev-list", "--count", `${a.epic.base_branch}..${a.epic.branch}`])).stdout.trim(), "1");
		assert.equal((await r.git(["rev-list", "--count", `${b.epic.base_branch}..${b.epic.branch}`])).stdout.trim(), "1");
	});

	it("shares one stories.db across every worktree", async () => {
		const r = await repo();
		const { epic } = await startedWorktreeEpic(r);

		// The same resolution the extension performs at session_start, but run
		// from inside the worktree — where a naive `git rev-parse --show-toplevel`
		// would open an empty database of its own and lose the epic.
		const fromWorktree = await resolvePaths({ cwd: epic.path!, git: r.git, env: {} });
		assert.equal(fromWorktree.repoRoot, r.dir);
		assert.equal(fromWorktree.dbPath, r.ctx.paths.dbPath);
	});

	it("lets a branch-mode epic and a worktree epic run side by side", async () => {
		const r = await repo();
		const worktreeEpic = await startedWorktreeEpic(r, "Alpha");

		const branchStory = makeStory(r, { title: "Beta" });
		makeStory(r, { title: "Beta — step one", parent_id: branchStory.id });
		const branchStarted = await startEpic(r.ctx, { story: branchStory });
		assert.ok(branchStarted.ok && branchStarted.epic, branchStarted.note);

		assert.equal(await currentBranch(r.git, r.dir), branchStarted.epic.branch);
		assert.equal(
			await currentBranch(r.git, worktreeEpic.epic.path!),
			worktreeEpic.epic.branch,
			"the branch-mode epic must not disturb the worktree",
		);
	});
});

describe("resolveSessionEpic", () => {
	it("gives each session the epic that owns the directory it is standing in", async () => {
		const r = await repo();
		const a = await startedWorktreeEpic(r, "Alpha");
		const b = await startedWorktreeEpic(r, "Beta");

		assert.equal((await resolveSessionEpic(r.ctx, a.epic.path!))?.epic_id, a.epic.epic_id);
		assert.equal((await resolveSessionEpic(r.ctx, b.epic.path!))?.epic_id, b.epic.epic_id);
	});

	it("finds no epic from the main checkout while only worktree epics run", async () => {
		const r = await repo();
		await startedWorktreeEpic(r);
		assert.equal(await resolveSessionEpic(r.ctx, r.dir), null);
	});

	it("finds the branch-mode epic from the main checkout", async () => {
		const r = await repo();
		const story = makeStory(r, { title: "Alpha" });
		makeStory(r, { title: "Alpha — step one", parent_id: story.id });
		const started = await startEpic(r.ctx, { story });
		assert.ok(started.epic);

		assert.equal((await resolveSessionEpic(r.ctx, r.dir))?.epic_id, started.epic!.epic_id);
	});

	it("stops resolving an epic once it is no longer active", async () => {
		const r = await repo();
		const { epic, child } = await startedWorktreeEpic(r);
		await closeStory(r, epic, child, "a.txt", "a\n");

		const merged = await mergeIntoBase(r.ctx, epic);
		assert.ok(merged.ok, merged.note);
		// The worktree still exists — /merge-epic removes it separately — so a
		// session sitting there must still be told the epic is over.
		assert.equal(await resolveSessionEpic(r.ctx, epic.path!), null);
	});

	/**
	 * The row is looked up by string equality against `rev-parse --show-toplevel`,
	 * and git reports resolved paths. On macOS every /tmp path is reached through
	 * a symlink, so storing the requested path rather than the resolved one made
	 * this lookup silently return null.
	 */
	it("matches the path git reports, not the one we asked for", async () => {
		const r = await repo();
		const { epic } = await startedWorktreeEpic(r);

		const reported = (await r.git(["rev-parse", "--show-toplevel"], { cwd: epic.path! })).stdout.trim();
		assert.equal(epic.path, reported);
		assert.equal(getEpicBranchByPath(r.db, reported)?.epic_id, epic.epic_id);
	});
});

describe("mergeIntoBase from a worktree", () => {
	it("fast-forwards the base branch without touching the main checkout's branch", async () => {
		const r = await repo();
		const { epic, child } = await startedWorktreeEpic(r);
		await closeStory(r, epic, child, "a.txt", "a\n");
		const epicTip = await r.sha(epic.branch);

		// Move the main checkout off the base branch, so a merge that checked it
		// out would be visible.
		await r.git(["switch", "--quiet", "-c", "feat/elsewhere"]);

		const merged = await mergeIntoBase(r.ctx, epic);
		assert.ok(merged.ok, merged.note);
		assert.equal(await r.sha(epic.base_branch), epicTip);
		assert.equal(
			await currentBranch(r.git, r.dir),
			"feat/elsewhere",
			"nobody had the base branch checked out, so nothing needed to move",
		);
		assert.equal(getEpicBranch(r.db, epic.epic_id)?.state, "merged");
	});

	it("updates the main checkout's working tree when it is on the base branch", async () => {
		const r = await repo();
		const { epic, child } = await startedWorktreeEpic(r);
		await closeStory(r, epic, child, "a.txt", "a\n");

		const merged = await mergeIntoBase(r.ctx, epic);
		assert.ok(merged.ok, merged.note);
		assert.ok(
			existsSync(join(r.dir, "a.txt")),
			"the main checkout is on the base branch, so the merge has to show up in its tree",
		);
	});

	it("refuses when another worktree holds the base branch", async () => {
		const r = await repo();
		const { epic, child } = await startedWorktreeEpic(r);
		await closeStory(r, epic, child, "a.txt", "a\n");

		// Somebody else's session, sitting on the base branch.
		const squatter = join(r.dir, "..", `squatter-${process.pid}`);
		await r.git(["switch", "--quiet", "-c", "feat/elsewhere"]);
		const added = await r.git(["worktree", "add", "--quiet", squatter, epic.base_branch]);
		assert.equal(added.code, 0, added.stderr);

		try {
			const merged = await mergeIntoBase(r.ctx, epic);
			assert.equal(merged.ok, false);
			assert.match(merged.note, /checked out in/);
			assert.equal(getEpicBranch(r.db, epic.epic_id)?.state, "active", "a refused merge changes nothing");
		} finally {
			await r.git(["worktree", "remove", "--force", squatter]);
		}
	});

	it("refuses instead of rewriting history when the base branch has moved", async () => {
		const r = await repo();
		const { epic, child } = await startedWorktreeEpic(r);
		await closeStory(r, epic, child, "a.txt", "a\n");

		// The base branch gains a commit the epic has never seen.
		r.write("base-moved.txt", "moved\n");
		await r.commit("base moves on");
		const baseTip = await r.sha(epic.base_branch);
		await r.git(["switch", "--quiet", "-c", "feat/elsewhere"]);

		const merged = await mergeIntoBase(r.ctx, epic);
		assert.equal(merged.ok, false);
		assert.match(merged.note, /has moved/);
		assert.equal(await r.sha(epic.base_branch), baseTip, "the base branch must not move on a refused merge");
	});

	it("restores the base branch on undo even from outside it", async () => {
		const r = await repo();
		const { epic, child } = await startedWorktreeEpic(r);
		await closeStory(r, epic, child, "a.txt", "a\n");
		const baseBefore = await r.sha(epic.base_branch);

		await r.git(["switch", "--quiet", "-c", "feat/elsewhere"]);
		assert.ok((await mergeIntoBase(r.ctx, epic)).ok);
		assert.notEqual(await r.sha(epic.base_branch), baseBefore);

		const undone = await undoMerge(r.ctx, getEpicBranch(r.db, epic.epic_id)!);
		assert.ok(undone.ok, undone.note);
		assert.equal(await r.sha(epic.base_branch), baseBefore);
		assert.equal(getEpicBranch(r.db, epic.epic_id)?.state, "active");
	});
});

describe("cancelEpic in worktree mode", () => {
	it("removes the worktree, frees the branch, and leaves the main checkout alone", async () => {
		const r = await repo();
		const { epic } = await startedWorktreeEpic(r);
		const path = epic.path!;
		const onBranch = await currentBranch(r.git, r.dir);

		const cancelled = await cancelEpic(r.ctx, epic, { deleteBranch: true });
		assert.ok(cancelled.ok, cancelled.note);

		assert.ok(!existsSync(path), "the worktree directory should be gone");
		assert.equal(await currentBranch(r.git, r.dir), onBranch, "the main checkout must not move");
		assert.equal(
			await revParse(r.git, `refs/heads/${epic.branch}`, r.dir),
			null,
			"deleting the branch is only possible once the worktree releases it",
		);

		const row = getEpicBranch(r.db, epic.epic_id);
		assert.equal(row?.state, "cancelled");
		assert.equal(row?.path, null, "path is non-null exactly while the worktree exists");
	});

	it("keeps the abandoned work reachable through the cancel backup", async () => {
		const r = await repo();
		const { epic, child } = await startedWorktreeEpic(r);
		await closeStory(r, epic, child, "a.txt", "a\n");
		const tip = await r.sha(epic.branch);

		assert.ok((await cancelEpic(r.ctx, epic, { deleteBranch: true })).ok);
		assert.equal(await revParse(r.git, backupRefName(epic.epic_id, "pre-cancel"), r.dir), tip);
	});

	it("refuses rather than discarding uncommitted work in the worktree", async () => {
		const r = await repo();
		const { epic } = await startedWorktreeEpic(r);
		writeFileSync(join(epic.path!, "scratch.txt"), "unsaved\n");

		const cancelled = await cancelEpic(r.ctx, epic);
		assert.equal(cancelled.ok, false, "git refuses to remove a dirty worktree, and so should we");
		assert.ok(existsSync(epic.path!));
		assert.equal(getEpicBranch(r.db, epic.epic_id)?.state, "active");
	});
});

describe("ref hygiene", () => {
	it("keeps only the newest checkpoints", async () => {
		const r = await repo();
		const { epic } = await startedWorktreeEpic(r);
		const head = await r.sha(epic.branch);

		for (let i = 0; i < 6; i++) {
			await r.git(["update-ref", `${checkpointRefPrefix(epic.epic_id)}/${1_700_000_000_000 + i}`, head]);
		}
		assert.equal((await listBackupRefs(r.git, checkpointRefPrefix(epic.epic_id), r.dir)).length, 6);

		const pruned = await pruneCheckpoints(r.ctx, epic, 2);
		assert.equal(pruned, 4);

		const left = await listBackupRefs(r.git, checkpointRefPrefix(epic.epic_id), r.dir);
		assert.deepEqual(left.map((ref) => ref.slice(ref.lastIndexOf("/") + 1)).sort(), [
			"1700000000004",
			"1700000000005",
		]);
	});

	it("prunes an epic's refs but never the one its undo depends on", async () => {
		const r = await repo();
		const { epic, child } = await startedWorktreeEpic(r);
		await closeStory(r, epic, child, "a.txt", "a\n");
		await r.git(["switch", "--quiet", "-c", "feat/elsewhere"]);
		assert.ok((await mergeIntoBase(r.ctx, epic)).ok);

		const before = await listBackupRefs(r.git, `refs/pi/backup/${epic.epic_id}`, r.dir);
		assert.ok(before.length > 1, "start and story backups should both exist by now");

		const pruned = await pruneEpicRefs(r.ctx, epic.epic_id, ["pre-merge"]);
		assert.equal(pruned, before.length - 1);

		const left = await listBackupRefs(r.git, `refs/pi/backup/${epic.epic_id}`, r.dir);
		assert.deepEqual(left, [backupRefName(epic.epic_id, "pre-merge")]);

		// And the merge is still undoable, which is the point of the exception.
		assert.ok((await undoMerge(r.ctx, getEpicBranch(r.db, epic.epic_id)!)).ok);
	});
});

describe("listWorktrees", () => {
	it("reports the main checkout and every linked worktree with its branch", async () => {
		const r = await repo();
		const { epic } = await startedWorktreeEpic(r);

		const entries = await listWorktrees(r.git, r.dir);
		const main = entries.find((entry) => entry.path === r.dir);
		const linked = entries.find((entry) => entry.path === epic.path);

		assert.ok(main, "the main checkout is a worktree too");
		assert.equal(main!.branch, epic.base_branch);
		assert.ok(linked);
		assert.equal(linked!.branch, epic.branch);
		assert.equal(linked!.detached, false);
	});

	it("reports a detached worktree as detached rather than inventing a branch", async () => {
		const r = await repo();
		const detached = join(r.dir, "..", `detached-${process.pid}`);
		const added = await r.git(["worktree", "add", "--quiet", "--detach", detached, "HEAD"]);
		assert.equal(added.code, 0, added.stderr);

		try {
			const entry = (await listWorktrees(r.git, r.dir)).find((e) => e.path === detached);
			assert.ok(entry);
			assert.equal(entry!.detached, true);
			assert.equal(entry!.branch, null);
		} finally {
			await r.git(["worktree", "remove", "--force", detached]);
		}
	});

	it("returns nothing outside a repository rather than throwing", async () => {
		const r = await repo();
		assert.deepEqual(await listWorktrees(r.git, "/"), []);
	});
});

describe("copyManifestFiles", () => {
	/**
	 * The manifest is a checked-in file. One that could copy /etc/shadow into a
	 * worktree would make opening a repository an attack.
	 */
	it("refuses absolute paths and anything reaching outside the repo", async () => {
		const r = await repo();
		const target = join(r.dir, "..", `copy-target-${process.pid}`);
		mkdirSync(target, { recursive: true });

		const result = copyManifestFiles(r.dir, target, ["/etc/hosts", "../outside.txt", "./README.md"]);
		assert.deepEqual(result.copied, ["README.md"]);
		assert.deepEqual(result.skipped, ["/etc/hosts", "../outside.txt"]);
		assert.ok(!existsSync(join(target, "etc", "hosts")));
	});

	it("copies nothing when the manifest declares nothing", async () => {
		const r = await repo();
		assert.deepEqual(copyManifestFiles(r.dir, r.dir, undefined), { copied: [], skipped: [] });
	});
});

describe("findMissingWorktrees", () => {
	const root = "/wt";
	function epicRow(overrides: Partial<EpicBranch> = {}): EpicBranch {
		return {
			epic_id: 1,
			mode: "worktree",
			branch: "epic/1-a",
			base_branch: "feat/x",
			base_commit: "a".repeat(40),
			path: "/wt/epic-1-a",
			state: "active",
			setup: {},
			created_at: 0,
			updated_at: 0,
			...overrides,
		};
	}
	function entry(path: string, overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
		return { path, head: null, branch: null, detached: false, prunable: false, ...overrides };
	}

	it("finds nothing to reconcile when the database and git agree", () => {
		const result = findMissingWorktrees([epicRow()], [entry("/wt/epic-1-a")], root);
		assert.deepEqual(result, { missing: [], orphaned: [] });
	});

	it("reports an active epic whose directory is gone — a crash or an rm -rf", () => {
		const result = findMissingWorktrees([epicRow()], [], root);
		assert.deepEqual(result.missing.map((e) => e.epic_id), [1]);
	});

	it("treats a prunable entry as gone, because git already knows it is", () => {
		const result = findMissingWorktrees([epicRow()], [entry("/wt/epic-1-a", { prunable: true })], root);
		assert.deepEqual(result.missing.map((e) => e.epic_id), [1]);
	});

	it("reports a managed directory no active epic claims", () => {
		const result = findMissingWorktrees([], [entry("/wt/epic-9-stale")], root);
		assert.deepEqual(result.orphaned.map((e) => e.path), ["/wt/epic-9-stale"]);
	});

	it("leaves the user's own worktrees alone — only our root is our business", () => {
		const result = findMissingWorktrees([], [entry("/somewhere/else"), entry("/wtx/not-ours")], root);
		assert.deepEqual(result.orphaned, []);
	});

	it("ignores epics that ended and epics that never had a worktree", () => {
		const rows = [
			epicRow({ epic_id: 2, state: "merged", path: "/wt/epic-2-b" }),
			epicRow({ epic_id: 3, mode: "branch", path: null }),
		];
		assert.deepEqual(findMissingWorktrees(rows, [], root), { missing: [], orphaned: [] });
	});
});
