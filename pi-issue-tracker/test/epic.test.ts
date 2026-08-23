import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createStory, getEpicBranch, getStoryCommit } from "../src/database.ts";
import {
	cancelEpic,
	commitStory,
	ensureDatabaseIgnored,
	findEpicForStory,
	mergeIntoBase,
	recordStoryStartCommit,
	runSetup,
	startEpic,
	undoMerge,
	undoStory,
	updateFromBase,
} from "../src/epic.ts";
import { currentBranch, revParse } from "../src/git.ts";
import type { Story } from "../src/types.ts";
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

/** An epic with two child stories, already started in branch mode. */
async function startedEpic(r: TempRepo) {
	const epicStory = makeStory(r, { title: "Add auth" });
	const first = makeStory(r, { title: "Hash passwords", parent_id: epicStory.id });
	const second = makeStory(r, { title: "Session cookies", parent_id: epicStory.id });
	const started = await startEpic(r.ctx, { story: epicStory });
	assert.ok(started.ok && started.epic, started.note);
	return { epicStory, first, second, epic: started.epic };
}

describe("startEpic", () => {
	it("creates the epic branch and records where it came from", async () => {
		const r = await repo();
		const { epic } = await startedEpic(r);

		assert.equal(epic.branch, "epic/1-add-auth");
		assert.equal(epic.base_branch, "feat/test");
		assert.equal(epic.state, "active");
		assert.equal(await currentBranch(r.git, r.dir), "epic/1-add-auth");
	});

	it("leaves the base branch untouched", async () => {
		const r = await repo();
		const before = await r.sha("feat/test");
		const { epic } = await startedEpic(r);
		r.write("a.txt", "work\n");
		await r.commit("work on the epic");

		assert.equal(await r.sha(epic.base_branch), before, "the base branch must not move until an explicit merge");
	});

	it("writes a backup ref before creating the branch", async () => {
		const r = await repo();
		await startedEpic(r);
		assert.ok(await revParse(r.git, "refs/pi/backup/1/pre-start", r.dir));
	});

	it("carries a dirty tree into the first commit when asked", async () => {
		const r = await repo();
		const epicStory = makeStory(r, { title: "Add auth" });
		makeStory(r, { title: "child", parent_id: epicStory.id });
		r.write("in-flight.txt", "unfinished\n");

		const started = await startEpic(r.ctx, { story: epicStory, carryDirty: true });
		assert.ok(started.ok, started.note);
		const log = await r.git(["log", "--oneline", "-1"]);
		assert.match(log.stdout, /carry uncommitted changes/);
	});
});

describe("ensureDatabaseIgnored", () => {
	it("takes the tracker's own database out of git status", async () => {
		const r = await repo();
		const before = await r.git(["status", "--porcelain", "--untracked-files=all"]);
		assert.match(before.stdout, /\.pi\/stories\.db/, "precondition: the database starts out untracked");

		await ensureDatabaseIgnored(r.ctx);

		const after = await r.git(["status", "--porcelain", "--untracked-files=all"]);
		assert.equal(after.stdout.trim(), "", "the database and its WAL siblings are all ignored");
	});

	it("is idempotent, so running it every session does not grow the exclude file", async () => {
		const r = await repo();
		await ensureDatabaseIgnored(r.ctx);
		const first = readFileSync(join(r.dir, ".git", "info", "exclude"), "utf-8");
		await ensureDatabaseIgnored(r.ctx);
		assert.equal(readFileSync(join(r.dir, ".git", "info", "exclude"), "utf-8"), first);
	});

	it("does nothing when the database lives outside the repository", async () => {
		const r = await repo();
		const outside = { ...r.ctx, paths: { ...r.ctx.paths, dbPath: "/tmp/elsewhere/stories.db" } };
		await ensureDatabaseIgnored(outside);
		const exclude = join(r.dir, ".git", "info", "exclude");
		const contents = existsSync(exclude) ? readFileSync(exclude, "utf-8") : "";
		assert.ok(!contents.includes("elsewhere"));
	});
});

describe("findEpicForStory", () => {
	it("finds the epic from a child story", async () => {
		const r = await repo();
		const { first, epicStory } = await startedEpic(r);
		assert.equal(findEpicForStory(r.ctx, first.id)?.epic_id, epicStory.id);
	});

	it("returns nothing for a story outside any epic", async () => {
		const r = await repo();
		await startedEpic(r);
		const loose = makeStory(r, { title: "unrelated" });
		assert.equal(findEpicForStory(r.ctx, loose.id), null);
	});

	it("stops finding an epic once it is merged", async () => {
		const r = await repo();
		const { first, epic } = await startedEpic(r);
		await mergeIntoBase(r.ctx, epic);
		assert.equal(findEpicForStory(r.ctx, first.id), null);
	});
});

describe("commitStory", () => {
	it("produces exactly one commit with the story in the subject", async () => {
		const r = await repo();
		const { first, epic } = await startedEpic(r);
		await recordStoryStartCommit(r.ctx, first, epic);

		r.write("hash.ts", "export const hash = () => 1;\n");
		const result = await commitStory(r.ctx, { ...first, resolution: "completed" }, epic);
		assert.ok(result.ok, result.note);

		const log = await r.git(["log", "--oneline", `${epic.base_branch}..HEAD`]);
		const subjects = log.stdout.trim().split("\n").filter(Boolean);
		assert.equal(subjects.length, 1);
		assert.match(subjects[0], /story\(#2\): Hash passwords \[completed\]/);
	});

	it("records the commit against the story so it can be undone", async () => {
		const r = await repo();
		const { first, epic } = await startedEpic(r);
		await recordStoryStartCommit(r.ctx, first, epic);
		r.write("hash.ts", "x\n");
		await commitStory(r.ctx, first, epic);

		const record = getStoryCommit(r.db, first.id);
		assert.ok(record?.commit_sha);
		assert.notEqual(record.commit_sha, record.start_commit);
	});

	it("reports a clean tree instead of failing or making an empty commit", async () => {
		const r = await repo();
		const { first, epic } = await startedEpic(r);
		const before = await r.sha();

		const result = await commitStory(r.ctx, first, epic);
		assert.ok(result.ok, "a story that changed nothing is not an error");
		assert.match(result.note, /nothing to commit/);
		assert.equal(await r.sha(), before, "no empty commit is created");
	});

	it("refuses a change that trips the size guard, and commits nothing", async () => {
		const r = await repo();
		const { first, epic } = await startedEpic(r);
		const before = await r.sha();
		mkdirSync(join(r.dir, "junk"), { recursive: true });
		for (let i = 0; i < 600; i++) writeFileSync(join(r.dir, "junk", `f${i}.txt`), "x");

		const result = await commitStory(r.ctx, first, epic);
		assert.equal(result.ok, false);
		assert.match(result.note, /refusing to commit/);
		assert.equal(await r.sha(), before);
	});

	it("does not commit when the manifest's verify command fails", async () => {
		const r = await repo();
		const { first, epic } = await startedEpic(r);
		const before = await r.sha();
		r.write("broken.ts", "x\n");

		const result = await commitStory(r.ctx, first, epic, { verify: "exit 3" });
		assert.equal(result.ok, false);
		assert.match(result.note, /verify failed \(exit 3\)/);
		assert.equal(await r.sha(), before, "a failing verify must leave history alone");
	});

	/**
	 * Regression: stories.db lives at <repo>/.pi/stories.db, so without an
	 * explicit exclude every `git add -A` swept the tracker's own binary state
	 * into the story's commit — and left the tree dirty enough to block the merge.
	 */
	it("never commits the tracker's own database", async () => {
		const r = await repo();
		const { first, epic } = await startedEpic(r);
		r.write("hash.ts", "x\n");
		const result = await commitStory(r.ctx, first, epic);
		assert.ok(result.ok, result.note);

		const files = await r.git(["show", "--name-only", "--format=", "HEAD"]);
		assert.equal(files.stdout.trim(), "hash.ts");

		const status = await r.git(["status", "--porcelain", "--untracked-files=all"]);
		assert.equal(status.stdout.trim(), "", "the tree is clean afterwards, so a merge is not blocked");
	});

	it("commits when verify passes", async () => {
		const r = await repo();
		const { first, epic } = await startedEpic(r);
		r.write("good.ts", "x\n");
		const result = await commitStory(r.ctx, first, epic, { verify: "true" });
		assert.ok(result.ok, result.note);
	});
});

describe("runSetup", () => {
	it("runs the declared command once and records what it ran", async () => {
		const r = await repo();
		const { epic } = await startedEpic(r);
		const marker = join(r.dir, "setup-count.txt");

		const manifest = { setup: `echo x >> ${marker}`, versions: "echo tools-1.0" };
		const first = await runSetup(r.ctx, epic, manifest);
		assert.ok(first.ok, first.note);

		const stored = getEpicBranch(r.db, epic.epic_id);
		assert.equal(stored?.setup.exit_code, 0);
		assert.equal(stored?.setup.versions, "tools-1.0");

		// Same command, so the epic must not pay for setup again.
		const second = await runSetup(r.ctx, stored!, manifest);
		assert.match(second.note, /already up to date/);
	});

	it("re-runs when the setup command itself changes", async () => {
		const r = await repo();
		const { epic } = await startedEpic(r);
		await runSetup(r.ctx, epic, { setup: "true" });
		const afterFirst = getEpicBranch(r.db, epic.epic_id)!;
		const result = await runSetup(r.ctx, afterFirst, { setup: "true # changed" });
		assert.ok(result.ok);
		assert.match(result.note, /setup completed/);
	});

	it("reports a failing setup rather than throwing", async () => {
		const r = await repo();
		const { epic } = await startedEpic(r);
		const result = await runSetup(r.ctx, epic, { setup: "exit 7" });
		assert.equal(result.ok, false);
		assert.match(result.note, /setup failed \(exit 7\)/);
	});
});

describe("updateFromBase", () => {
	it("is a no-op when the base branch has not moved", async () => {
		const r = await repo();
		const { epic } = await startedEpic(r);
		const result = await updateFromBase(r.ctx, epic);
		assert.ok(result.ok);
		assert.match(result.note, /already up to date/);
	});

	it("brings in base-branch commits made after the epic started", async () => {
		const r = await repo();
		const { epic } = await startedEpic(r);
		await r.git(["switch", "--quiet", epic.base_branch]);
		r.write("from-base.txt", "base moved\n");
		await r.commit("base branch moved on");
		await r.git(["switch", "--quiet", epic.branch]);

		const result = await updateFromBase(r.ctx, epic);
		assert.ok(result.ok, result.note);
		const listed = await r.git(["log", "--oneline"]);
		assert.match(listed.stdout, /base branch moved on/);
	});

	/**
	 * The reason the merge runs in this direction: the conflict has to appear
	 * where the agent is working so it can resolve it, not in a checkout it is
	 * not in.
	 */
	it("reports conflicting paths rather than failing opaquely", async () => {
		const r = await repo();
		const { epic } = await startedEpic(r);
		r.write("shared.txt", "epic version\n");
		await r.commit("epic edits shared.txt");

		await r.git(["switch", "--quiet", epic.base_branch]);
		r.write("shared.txt", "base version\n");
		await r.commit("base edits shared.txt");
		await r.git(["switch", "--quiet", epic.branch]);

		const result = await updateFromBase(r.ctx, epic);
		assert.equal(result.ok, false);
		assert.deepEqual(result.conflicts, ["shared.txt"]);
		assert.match(result.note, /shared\.txt/);
	});
});

describe("mergeIntoBase", () => {
	it("fast-forwards the base branch and marks the epic merged", async () => {
		const r = await repo();
		const { first, epic } = await startedEpic(r);
		r.write("hash.ts", "x\n");
		await commitStory(r.ctx, first, epic);
		const epicTip = await r.sha(epic.branch);

		const result = await mergeIntoBase(r.ctx, epic);
		assert.ok(result.ok, result.note);
		assert.equal(await r.sha(epic.base_branch), epicTip);
		assert.equal(getEpicBranch(r.db, epic.epic_id)?.state, "merged");
	});

	it("refuses when the main checkout is dirty", async () => {
		const r = await repo();
		const { epic } = await startedEpic(r);
		r.write("uncommitted.txt", "in flight\n");
		const result = await mergeIntoBase(r.ctx, epic);
		assert.equal(result.ok, false);
		assert.match(result.note, /uncommitted changes/);
	});

	/**
	 * --ff-only is what makes step 2 safe. If the base branch moved, the merge
	 * must refuse rather than start a real merge that can conflict halfway
	 * through the user's own checkout.
	 */
	it("refuses instead of conflicting when the base branch has moved", async () => {
		const r = await repo();
		const { first, epic } = await startedEpic(r);
		r.write("hash.ts", "x\n");
		await commitStory(r.ctx, first, epic);

		await r.git(["switch", "--quiet", epic.base_branch]);
		r.write("elsewhere.txt", "base moved\n");
		await r.commit("base moved");
		const baseTip = await r.sha(epic.base_branch);

		const result = await mergeIntoBase(r.ctx, epic);
		assert.equal(result.ok, false);
		assert.match(result.note, /has moved/);
		assert.equal(await r.sha(epic.base_branch), baseTip, "the base branch is left exactly as it was");
	});

	it("succeeds after updating from the moved base branch", async () => {
		const r = await repo();
		const { first, epic } = await startedEpic(r);
		r.write("hash.ts", "x\n");
		await commitStory(r.ctx, first, epic);

		await r.git(["switch", "--quiet", epic.base_branch]);
		r.write("elsewhere.txt", "base moved\n");
		await r.commit("base moved");
		await r.git(["switch", "--quiet", epic.branch]);

		assert.ok((await updateFromBase(r.ctx, epic)).ok);
		const merged = await mergeIntoBase(r.ctx, epic);
		assert.ok(merged.ok, merged.note);
	});
});

describe("undo", () => {
	it("resets a story that is still the tip, keeping the work reachable", async () => {
		const r = await repo();
		const { first, epic } = await startedEpic(r);
		await recordStoryStartCommit(r.ctx, first, epic);
		const start = await r.sha();
		r.write("hash.ts", "x\n");
		await commitStory(r.ctx, first, epic);
		const storyTip = await r.sha();

		const result = await undoStory(r.ctx, first.id, epic);
		assert.ok(result.ok, result.note);
		assert.equal(await r.sha(), start, "HEAD returns to where the story began");
		assert.equal(
			await revParse(r.git, `refs/pi/backup/${epic.epic_id}/pre-undo-${first.id}`, r.dir),
			storyTip,
			"the discarded commit is still reachable through its backup ref",
		);
	});

	it("reverts a story that is no longer the tip, so later work survives", async () => {
		const r = await repo();
		const { first, second, epic } = await startedEpic(r);
		await recordStoryStartCommit(r.ctx, first, epic);
		r.write("hash.ts", "x\n");
		await commitStory(r.ctx, first, epic);

		await recordStoryStartCommit(r.ctx, second, epic);
		r.write("cookies.ts", "y\n");
		await commitStory(r.ctx, second, epic);
		const tipBefore = await r.sha();

		const result = await undoStory(r.ctx, first.id, epic);
		assert.ok(result.ok, result.note);
		assert.match(result.note, /reverted/);

		const log = await r.git(["log", "--oneline"]);
		assert.match(log.stdout, /Session cookies/, "the later story's commit is untouched");
		assert.notEqual(await r.sha(), tipBefore, "the revert added a commit rather than discarding one");
	});

	it("restores the base branch exactly after a merge", async () => {
		const r = await repo();
		const { first, epic } = await startedEpic(r);
		r.write("hash.ts", "x\n");
		await commitStory(r.ctx, first, epic);

		const baseBefore = await r.sha(epic.base_branch);
		assert.ok((await mergeIntoBase(r.ctx, epic)).ok);
		assert.notEqual(await r.sha(epic.base_branch), baseBefore);

		const undone = await undoMerge(r.ctx, epic);
		assert.ok(undone.ok, undone.note);
		assert.equal(await r.sha(epic.base_branch), baseBefore, "byte-identical to before the merge");
		assert.equal(getEpicBranch(r.db, epic.epic_id)?.state, "active", "the epic is workable again");
	});

	it("says so when there is no merge to undo", async () => {
		const r = await repo();
		const { epic } = await startedEpic(r);
		const result = await undoMerge(r.ctx, epic);
		assert.equal(result.ok, false);
		assert.match(result.note, /nothing to undo/);
	});
});

describe("cancelEpic", () => {
	it("returns to the base branch and keeps the work reachable", async () => {
		const r = await repo();
		const { first, epic } = await startedEpic(r);
		r.write("hash.ts", "x\n");
		await commitStory(r.ctx, first, epic);
		const epicTip = await r.sha(epic.branch);

		const result = await cancelEpic(r.ctx, epic);
		assert.ok(result.ok, result.note);
		assert.equal(await currentBranch(r.git, r.dir), epic.base_branch);
		assert.equal(getEpicBranch(r.db, epic.epic_id)?.state, "cancelled");
		assert.equal(await revParse(r.git, `refs/pi/backup/${epic.epic_id}/pre-cancel`, r.dir), epicTip);
	});

	it("keeps the branch by default, so cancelling is itself reversible", async () => {
		const r = await repo();
		const { epic } = await startedEpic(r);
		await cancelEpic(r.ctx, epic);
		assert.ok(await revParse(r.git, epic.branch, r.dir), "the epic branch still exists");
	});

	it("deletes the branch on request, with the tip still held by the backup ref", async () => {
		const r = await repo();
		const { first, epic } = await startedEpic(r);
		r.write("hash.ts", "x\n");
		await commitStory(r.ctx, first, epic);
		const epicTip = await r.sha(epic.branch);

		await cancelEpic(r.ctx, epic, { deleteBranch: true });
		assert.equal(await revParse(r.git, epic.branch, r.dir), null);
		assert.equal(await revParse(r.git, `refs/pi/backup/${epic.epic_id}/pre-cancel`, r.dir), epicTip);
	});
});
