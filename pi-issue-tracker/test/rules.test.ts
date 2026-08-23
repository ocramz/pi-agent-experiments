import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	backupRefName,
	checkCanMerge,
	checkCanStartEpic,
	checkStageSize,
	checkpointRefPrefix,
	chooseUndoStrategy,
	epicBranchName,
	isBranchEscapingCommand,
	refsToPrune,
	slugify,
	storyCommitMessage,
	worktreeDirName,
	type ActiveEpicSummary,
} from "../src/rules.ts";
import type { EpicBranch, Story, StoryCommit } from "../src/types.ts";

function story(overrides: Partial<Story> = {}): Story {
	return {
		id: 12,
		title: "Add auth",
		sub_goal: "Users can sign in",
		proposed_changes: "add a login route",
		status: "ready",
		priority: 0,
		parent_id: null,
		next_id: null,
		depends_on: [],
		resolution: null,
		resolution_note: null,
		learnings: null,
		created_at: 0,
		updated_at: 0,
		...overrides,
	};
}

function active(overrides: Partial<ActiveEpicSummary> = {}): ActiveEpicSummary {
	return { epic_id: 7, mode: "branch", branch: "epic/7-other", path: null, ...overrides };
}

const base = {
	isRepo: true,
	branch: "feat/test",
	dirty: false,
	story: story(),
	childCount: 2,
	mode: "branch" as const,
	activeEpics: [] as ActiveEpicSummary[],
};

describe("checkCanStartEpic", () => {
	it("accepts an epic on a working branch with a clean tree", () => {
		assert.deepEqual(checkCanStartEpic(base), { ok: true });
	});

	it("refuses outside a git repository", () => {
		const result = checkCanStartEpic({ ...base, isRepo: false });
		assert.equal(result.ok, false);
	});

	for (const branch of ["main", "master"]) {
		it(`refuses to start from ${branch}`, () => {
			const result = checkCanStartEpic({ ...base, branch });
			assert.equal(result.ok, false);
			assert.match((result as { reason: string }).reason, new RegExp(branch));
		});
	}

	it("refuses on a detached HEAD", () => {
		const result = checkCanStartEpic({ ...base, branch: null });
		assert.equal(result.ok, false);
		assert.match((result as { reason: string }).reason, /detached/);
	});

	it("refuses a leaf story — an epic is a story with children", () => {
		const result = checkCanStartEpic({ ...base, childCount: 0 });
		assert.equal(result.ok, false);
		assert.match((result as { reason: string }).reason, /unit of work/);
	});

	it("refuses a second branch-mode epic — they would fight over the main checkout", () => {
		const result = checkCanStartEpic({ ...base, activeEpics: [active()] });
		assert.equal(result.ok, false);
		assert.match((result as { reason: string }).reason, /#7/);
		assert.match(
			(result as { reason: string }).reason,
			/--worktree/,
			"the refusal should point at the mode that would have worked",
		);
	});

	it("refuses to restart a story that already has an active epic", () => {
		const result = checkCanStartEpic({ ...base, activeEpics: [active({ epic_id: 12 })] });
		assert.equal(result.ok, false);
		assert.match((result as { reason: string }).reason, /already active/);
	});

	it("refuses a dirty tree, but accepts it once the user agrees to carry it", () => {
		assert.equal(checkCanStartEpic({ ...base, dirty: true }).ok, false);
		assert.equal(checkCanStartEpic({ ...base, dirty: true, carryDirty: true }).ok, true);
	});

	describe("worktree mode", () => {
		const worktree = { ...base, mode: "worktree" as const };

		it("starts alongside any number of other epics, in either mode", () => {
			const others = [
				active({ epic_id: 7, mode: "branch" }),
				active({ epic_id: 8, mode: "worktree", path: "/wt/epic-8" }),
				active({ epic_id: 9, mode: "worktree", path: "/wt/epic-9" }),
			];
			assert.deepEqual(checkCanStartEpic({ ...worktree, activeEpics: others }), { ok: true });
		});

		it("ignores a dirty main tree — worktree add never touches it", () => {
			assert.deepEqual(checkCanStartEpic({ ...worktree, dirty: true }), { ok: true });
		});

		it("refuses when the branch or the directory is already taken", () => {
			const onBranch = checkCanStartEpic({ ...worktree, branchExists: true });
			assert.equal(onBranch.ok, false);
			assert.match((onBranch as { reason: string }).reason, /epic\/12-add-auth/);

			const onPath = checkCanStartEpic({ ...worktree, pathExists: true });
			assert.equal(onPath.ok, false);
			assert.match((onPath as { reason: string }).reason, /epic-12-add-auth/);
		});

		it("still refuses a leaf story and a protected base branch", () => {
			assert.equal(checkCanStartEpic({ ...worktree, childCount: 0 }).ok, false);
			assert.equal(checkCanStartEpic({ ...worktree, branch: "main" }).ok, false);
		});
	});
});

function epic(overrides: Partial<EpicBranch> = {}): EpicBranch {
	return {
		epic_id: 12,
		mode: "worktree",
		branch: "epic/12-add-auth",
		base_branch: "feat/test",
		base_commit: "a".repeat(40),
		path: "/wt/epic-12-add-auth",
		state: "active",
		setup: {},
		created_at: 0,
		updated_at: 0,
		...overrides,
	};
}

describe("checkCanMerge", () => {
	const base = { epic: epic(), baseCheckedOutAt: null, repoRoot: "/repo", mainCheckoutEpicId: null };

	it("accepts when nothing holds the base branch", () => {
		assert.deepEqual(checkCanMerge(base), { ok: true });
	});

	it("accepts when the main checkout holds it — that is where the merge lands", () => {
		assert.deepEqual(checkCanMerge({ ...base, baseCheckedOutAt: "/repo" }), { ok: true });
	});

	it("refuses when another worktree holds the base branch", () => {
		const result = checkCanMerge({ ...base, baseCheckedOutAt: "/wt/epic-9" });
		assert.equal(result.ok, false);
		assert.match((result as { reason: string }).reason, /\/wt\/epic-9/);
	});

	it("refuses to fast-forward past a branch-mode epic occupying the main checkout", () => {
		const result = checkCanMerge({ ...base, mainCheckoutEpicId: 7 });
		assert.equal(result.ok, false);
		assert.match((result as { reason: string }).reason, /#7/);
	});

	it("does not block a branch-mode epic on itself", () => {
		const own = epic({ epic_id: 7, mode: "branch", path: null });
		assert.deepEqual(checkCanMerge({ ...base, epic: own, mainCheckoutEpicId: 7 }), { ok: true });
	});

	it("refuses an epic that already ended", () => {
		assert.equal(checkCanMerge({ ...base, epic: epic({ state: "merged" }) }).ok, false);
	});
});

describe("refsToPrune", () => {
	const prefix = checkpointRefPrefix(3);
	const refs = [1, 2, 3, 4, 5].map((n) => `${prefix}/${1_700_000_000_000 + n}`);

	it("keeps the newest N and returns the rest", () => {
		const doomed = refsToPrune(refs, 2);
		assert.deepEqual(doomed, [
			`${prefix}/1700000000003`,
			`${prefix}/1700000000002`,
			`${prefix}/1700000000001`,
		]);
	});

	it("prunes nothing when there are fewer refs than the limit", () => {
		assert.deepEqual(refsToPrune(refs, 10), []);
	});

	it("orders by the timestamp, not the string, and prunes unparseable names first", () => {
		// A name outside the fixed-width era sorts wrong lexically but right numerically.
		const mixed = [`${prefix}/999`, `${prefix}/1700000000001`, `${prefix}/scratch`];
		assert.deepEqual(refsToPrune(mixed, 1), [`${prefix}/999`, `${prefix}/scratch`]);
	});
});

describe("worktreeDirName", () => {
	it("is a flat directory name, not a path — worktrees are siblings under one root", () => {
		assert.equal(worktreeDirName(story()), "epic-12-add-auth");
		assert.equal(worktreeDirName(story({ id: 3, title: "Fix the / thing" })), "epic-3-fix-the-thing");
	});
});

describe("naming", () => {
	it("slugifies titles", () => {
		assert.equal(slugify("Add OAuth 2.0 support!"), "add-oauth-2-0-support");
		assert.equal(slugify("  spaced  out  "), "spaced-out");
	});

	it("never produces an empty slug, which would make an invalid ref", () => {
		assert.equal(slugify("!!!"), "epic");
		assert.equal(slugify(""), "epic");
	});

	it("trims a trailing dash left by truncation", () => {
		assert.ok(!slugify("a".repeat(30) + " " + "b".repeat(30)).endsWith("-"));
	});

	it("builds branch and backup ref names", () => {
		assert.equal(epicBranchName(story()), "epic/12-add-auth");
		assert.equal(backupRefName(12, "pre-merge"), "refs/pi/backup/12/pre-merge");
	});
});

describe("storyCommitMessage", () => {
	it("puts id, title and resolution in the subject", () => {
		const message = storyCommitMessage(story({ resolution: "completed" }));
		assert.equal(message.subject, "story(#12): Add auth [completed]");
		assert.match(message.body, /Users can sign in/);
	});

	it("includes resolution note and learnings when present", () => {
		const message = storyCommitMessage(
			story({ resolution: "superseded", resolution_note: "folded into #13", learnings: "the API paginates" }),
		);
		assert.match(message.body, /folded into #13/);
		assert.match(message.body, /the API paginates/);
	});

	it("omits the resolution marker while the story is still open", () => {
		assert.equal(storyCommitMessage(story()).subject, "story(#12): Add auth");
	});
});

describe("chooseUndoStrategy", () => {
	const record = (overrides: Partial<StoryCommit> = {}): StoryCommit => ({
		story_id: 12,
		epic_id: 1,
		start_commit: "aaa",
		commit_sha: "bbb",
		backup_ref: null,
		created_at: 0,
		...overrides,
	});

	it("resets to the start commit while the story is still the tip", () => {
		assert.deepEqual(chooseUndoStrategy(record(), "bbb"), { kind: "reset", to: "aaa" });
	});

	it("reverts once other commits sit on top, so nothing is silently discarded", () => {
		assert.deepEqual(chooseUndoStrategy(record(), "ccc"), { kind: "revert", sha: "bbb" });
	});

	it("does nothing for a story that closed without changes", () => {
		assert.equal(chooseUndoStrategy(record({ commit_sha: null }), "ccc").kind, "none");
	});

	it("does nothing for an unknown story", () => {
		assert.equal(chooseUndoStrategy(null, "ccc").kind, "none");
	});
});

describe("checkStageSize", () => {
	it("allows an ordinary change", () => {
		assert.equal(checkStageSize({ fileCount: 8, totalBytes: 40_000 }).ok, true);
	});

	it("blocks a change that looks like a stray build directory", () => {
		assert.equal(checkStageSize({ fileCount: 5_000, totalBytes: 1_000 }).ok, false);
	});

	it("blocks an oversized change, such as a committed model file", () => {
		assert.equal(checkStageSize({ fileCount: 1, totalBytes: 200 * 1024 * 1024 }).ok, false);
	});
});

describe("isBranchEscapingCommand", () => {
	for (const command of [
		"git switch main",
		"git checkout main",
		"git reset --hard HEAD~1",
		"git branch -D epic/12-add-auth",
		"cd /tmp && git worktree remove /tmp/wt",
	]) {
		it(`blocks: ${command}`, () => assert.equal(isBranchEscapingCommand(command), true));
	}

	for (const command of [
		"git switch -c feature/x",
		"git checkout -- src/app.ts",
		"git status",
		"git commit -m 'reset the counter'",
		"git reset HEAD~1",
	]) {
		it(`allows: ${command}`, () => assert.equal(isBranchEscapingCommand(command), false));
	}
});
