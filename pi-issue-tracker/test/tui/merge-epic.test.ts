// /merge-epic and /cancel-epic.
//
// Merging is two steps in a fixed order: `merge --no-ff <base>` into the epic
// branch first, so conflicts land where the agent is working, then
// `merge --ff-only` into the base branch, which cannot conflict. Step 2 is
// user-confirmed, which is the select prompt these cases answer.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getEpicBranch } from "../../src/database.ts";
import { session } from "./pi-session.ts";

describe("/merge-epic", () => {
	it("E1 fast-forwards the base branch when confirmed", async (t) => {
		const s = await session(t, "epicOneCommit");
		const { epicId: epic, baseBranch: base } = s.facts;
		const tip = await s.git("rev-parse", "HEAD");

		await s.command(`/merge-epic ${epic}`);
		await s.expect(`Merge epic/${epic}-ship-the-widget into ${base}?`);
		await s.choose(0); // "Yes, fast-forward <base>"
		await s.expect(`merged epic/${epic}-ship-the-widget into ${base}`);
		await s.close();

		assert.equal(await s.git("rev-parse", base!), tip, "the base branch fast-forwarded to the epic tip");
		assert.equal(s.db((db) => getEpicBranch(db, epic!)?.state), "merged", "the epic is recorded as merged");
	});

	it("E2 leaves everything alone when declined", async (t) => {
		const s = await session(t, "epicOneCommit");
		const { epicId: epic, baseBranch: base } = s.facts;
		const before = await s.git("rev-parse", base!);

		await s.command(`/merge-epic ${epic}`);
		await s.expect(`Merge epic/${epic}-ship-the-widget into ${base}?`);
		await s.choose(1); // "No, leave the branch for me"
		await s.expect("Left the epic branch as it is.");
		await s.close();

		assert.equal(await s.git("rev-parse", base!), before, "the base branch did not move");
		assert.equal(s.db((db) => getEpicBranch(db, epic!)?.state), "active", "the epic is still active");
	});

	it("E3 re-runs step 1 when the base moved, then fast-forwards", async (t) => {
		const s = await session(t, "epicBaseMoved");
		const { epicId: epic, baseBranch: base } = s.facts;

		await s.command(`/merge-epic ${epic}`);
		await s.expect(`Merge epic/${epic}-ship-the-widget into ${base}?`);
		await s.choose(0);
		await s.expect(`merged epic/${epic}-ship-the-widget into ${base}`);
		await s.close();

		assert.equal(s.db((db) => getEpicBranch(db, epic!)?.state), "merged", "the epic is recorded as merged");
		assert.equal(
			await s.git("rev-parse", base!),
			await s.git("rev-parse", "HEAD"),
			"the base branch now contains the epic",
		);
		assert.match(
			await s.git("ls-tree", "-r", "--name-only", base!),
			/base-change\.txt/,
			"the base branch's own change survived",
		);
	});

	it("E4 reports a step 1 conflict and leaves the base untouched", async (t) => {
		const s = await session(t, "epicConflict");
		const { epicId: epic, baseBranch: base } = s.facts;
		const before = await s.git("rev-parse", base!);

		await s.command(`/merge-epic ${epic}`);
		await s.expect("contested.txt");
		// The conflict is reported before the confirmation, so the prompt that
		// would fast-forward the base branch is never reached.
		s.refute("Yes, fast-forward");
		await s.close();

		assert.equal(await s.git("rev-parse", base!), before, "the base branch was left untouched");
		assert.equal(s.db((db) => getEpicBranch(db, epic!)?.state), "active", "the epic is still active");
	});

	it("E5 warns that the epic is already merged", async (t) => {
		const s = await session(t, "epicMerged");
		const { epicId: epic, baseBranch: base } = s.facts;
		const before = await s.git("rev-parse", base!);

		await s.command(`/merge-epic ${epic}`);
		await s.expect(`Epic #${epic} is already merged.`);
		await s.close();

		assert.equal(await s.git("rev-parse", base!), before, "the base branch did not move again");
	});
});

describe("/cancel-epic", () => {
	it("F1 cancels the epic and keeps its branch", async (t) => {
		const s = await session(t, "epicActive");
		const { epicId: epic, baseBranch: base, branch } = s.facts;

		await s.command(`/cancel-epic ${epic}`);
		await s.expect(`epic #${epic} cancelled, back on ${base}`);
		await s.close();

		assert.equal(s.db((db) => getEpicBranch(db, epic!)?.state), "cancelled", "the epic is recorded as cancelled");
		assert.ok(await s.git("branch", "--list", branch!), "the epic branch still exists");
		assert.equal(await s.branch(), base, "HEAD returned to the base branch");
	});

	it("F2 reports when there is no epic to cancel", async (t) => {
		const s = await session(t, "stories");
		await s.command("/cancel-epic");
		await s.expect("no epic is active — pass an id, or start one with /start-epic");
		await s.close();
	});
});
