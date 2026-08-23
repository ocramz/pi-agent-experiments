// /undo-story, /undo-merge and /undo-turn.
//
// /undo-story picks its strategy from where the story's commit sits: a reset
// while it is still the tip, a revert once anything newer is on top of it —
// because a reset off the tip would discard the newer work silently.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { session } from "./pi-session.ts";

describe("/undo-story", () => {
	it("G1 resets when the story commit is at the tip", async (t) => {
		const s = await session(t, "epicOneCommit");
		const first = s.facts.firstId!;
		const before = await s.count();

		await s.command(`/undo-story ${first}`);
		await s.expect(`story #${first} reset to`);
		await s.close();

		assert.equal(await s.count(), before - 1, "the tip commit was removed by reset");
		assert.equal(s.exists("model.ts"), false, "the story's file is gone");
	});

	it("G2 reverts when the story commit is behind the tip", async (t) => {
		const s = await session(t, "epicTwoCommits");
		const first = s.facts.firstId!;
		const before = await s.count();

		await s.command(`/undo-story ${first}`);
		await s.expect(`story #${first} reverted (its commit is kept in history).`);
		await s.close();

		assert.equal(await s.count(), before + 1, "a revert commit was added");
		assert.ok(s.exists("view.ts"), "the later story's file is untouched");
		assert.equal(s.exists("model.ts"), false, "the reverted story's file is gone");
	});

	it("G3 says so when the story closed without changes", async (t) => {
		const s = await session(t, "epicActive");
		const first = s.facts.firstId!;
		const before = await s.count();

		await s.command(`/undo-story ${first}`);
		await s.expect(`story #${first}: story closed without changes — nothing to undo`);
		await s.close();

		assert.equal(await s.count(), before, "no commit was added or removed");
	});

	it("G4 refuses a story outside an active epic", async (t) => {
		const s = await session(t, "stories");
		const loose = s.facts.looseId!;

		await s.command(`/undo-story ${loose}`);
		await s.expect(`Story #${loose} is not part of an active epic.`);
		await s.close();
	});
});

describe("/undo-merge", () => {
	it("H1 restores the base branch", async (t) => {
		const s = await session(t, "epicMerged");
		const { epicId: epic, baseBranch: base, baseTip } = s.facts;
		const before = await s.git("rev-parse", base!);
		assert.equal(before, baseTip, "the fixture really did merge");

		await s.command(`/undo-merge ${epic}`);
		await s.expect(`${base} restored to`);
		await s.close();

		assert.notEqual(await s.git("rev-parse", base!), before, "the base branch moved back off the merge");
		assert.ok(await s.git("branch", "--list", `epic/${epic}-*`), "the epic branch survives the undo");
	});

	it("H2 reports when no epic has been merged", async (t) => {
		const s = await session(t, "stories");
		await s.command("/undo-merge");
		await s.expect("No merged epic to undo — pass a story id.");
		await s.close();
	});

	// There is deliberately no case here for /undo-merge's no-argument epic
	// selection against more than one merged epic. The ordering it depends on is
	// correct now — timestamps come from ctx.now at millisecond resolution and
	// selection is by updated_at, so "the epic that merged last" is a real answer
	// rather than a tie broken by rowid — but asserting it needs a controlled
	// clock, which makes it a unit test. It is in ../database.test.ts as "picks
	// the last merged epic by when it merged, not by when it started".
});

describe("/undo-turn", () => {
	it("I2 warns when this session is not working on an epic", async (t) => {
		const s = await session(t, "stories");
		await s.command("/undo-turn");
		await s.expect("This session is not working on an epic, so no checkpoints are being taken.");
		await s.close();

		assert.deepEqual(await s.piRefs("checkpoint"), [], "no checkpoint refs exist");
	});

	it("I3 reports when no checkpoint exists yet", async (t) => {
		const s = await session(t, "epicActive");
		// Run before sending any prompt: turn_end is what writes a checkpoint, and
		// no turn has ended.
		await s.command("/undo-turn");
		await s.expect("No checkpoint recorded yet.");
		await s.close();

		assert.deepEqual(await s.piRefs("checkpoint"), [], "no checkpoint refs exist");
	});
});
