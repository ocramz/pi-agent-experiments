import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	backupRefName,
	checkCanStartEpic,
	checkStageSize,
	chooseUndoStrategy,
	epicBranchName,
	isBranchEscapingCommand,
	slugify,
	storyCommitMessage,
} from "../src/rules.ts";
import type { Story, StoryCommit } from "../src/types.ts";

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

const base = {
	isRepo: true,
	branch: "feat/test",
	dirty: false,
	story: story(),
	childCount: 2,
	activeEpicId: null,
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

	it("refuses a second epic while one is active", () => {
		const result = checkCanStartEpic({ ...base, activeEpicId: 7 });
		assert.equal(result.ok, false);
		assert.match((result as { reason: string }).reason, /#7/);
	});

	it("allows resuming the epic that is already active", () => {
		assert.deepEqual(checkCanStartEpic({ ...base, activeEpicId: 12 }), { ok: true });
	});

	it("refuses a dirty tree, but accepts it once the user agrees to carry it", () => {
		assert.equal(checkCanStartEpic({ ...base, dirty: true }).ok, false);
		assert.equal(checkCanStartEpic({ ...base, dirty: true, carryDirty: true }).ok, true);
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
