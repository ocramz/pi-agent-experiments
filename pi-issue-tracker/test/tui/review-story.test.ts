// J — /review-story
//
// The two review gates are *tool* actions, and the model is the only thing that
// can call a tool, so they cannot be driven from the TUI directly. What can be
// driven is `/review-story`, which runs the same `reviewPlan` / `reviewWork`
// from `src/rules.ts` and prints the findings. These cases therefore cover the
// mechanical half of every review — the half that decides what may be approved
// — deterministically, with no model and no cost.
//
// The verdict-recording half is covered in test/review.test.ts against a stub
// reviewer, and the wiring to a real second model in
// test/container/test_extension_live.sh.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getStoryById } from "../../src/database.ts";
import { session } from "./session.ts";

describe("/review-story", () => {
	it("J1 reports a clean bill for a well-formed leaf story", async (t) => {
		const s = await session(t, "stories");
		await s.command(`/review-story ${s.facts.firstId}`);
		await s.expect("Plan review");
		await s.expect(`#${s.facts.firstId}`);
		await s.expect("No verdict recorded yet");
		await s.close();

		// Read-only: the human's window onto the checks, not a way to record a
		// verdict on the agent's behalf.
		assert.deepEqual(s.db((db) => getStoryById(db, s.facts.firstId!)?.review), {}, "no verdict was recorded");
	});

	/**
	 * The gap that only opens once an agent authors its own graph: nothing in the
	 * tool path prevents A→B→A, `wouldCreateCycle` guards `parent_id` only, and
	 * every gate then refuses forever with no way out but editing the row.
	 */
	it("J2 names a dependency cycle as a blocker", async (t) => {
		const s = await session(t, "cyclicDeps");
		await s.command(`/review-story ${s.facts.firstId}`);
		await s.expect("BLOCKER");
		await s.expect("dependency cycle");
		await s.close();
	});

	it("J3 blocks an epic — epics are never handed out as work", async (t) => {
		const s = await session(t, "stories");
		await s.command(`/review-story ${s.facts.epicId}`);
		await s.expect("BLOCKER");
		await s.expect("is an epic with 2 child stories");
		await s.close();
	});

	it("J4 refuses an unknown story and changes nothing", async (t) => {
		const s = await session(t, "stories");
		await s.command("/review-story 999");
		await s.expect("Story #999 not found");
		await s.close();

		assert.deepEqual(s.db((db) => getStoryById(db, s.facts.firstId!)?.review), {}, "no review was recorded anywhere");
	});

	it("J4b refuses a non-numeric argument with usage", async (t) => {
		const s = await session(t, "stories");
		await s.command("/review-story");
		await s.expect("Usage: /review-story <story_id>");
		await s.close();
	});

	it("J5 shows a recorded verdict and who reached it", async (t) => {
		const s = await session(t, "reviewed");
		await s.command(`/review-story ${s.facts.firstId}`);
		await s.expect("Recorded: approved by stub/reviewer-1");
		await s.close();
	});

	it("J6 shows a changes_requested verdict too", async (t) => {
		const s = await session(t, "reviewed");
		await s.command(`/review-story ${s.facts.secondId}`);
		await s.expect("Recorded: changes_requested by self");
		await s.close();
	});

	// `work` selects the other gate. Outside an epic there is no working tree to
	// inspect, and saying so is more useful than reporting a clean bill.
	it("J7 reports the work gate separately from the plan gate", async (t) => {
		const s = await session(t, "stories");
		await s.command(`/review-story ${s.facts.firstId} work`);
		await s.expect("Work review");
		await s.expect("not under a started epic");
		await s.close();
	});

	it("J8 reviews the work of a story inside an active epic", async (t) => {
		const s = await session(t, "epicActive");
		await s.command(`/review-story ${s.facts.firstId} work`);
		await s.expect("Work review");
		// A clean tree is a note, not a blocker — closing as obsolete is legitimate.
		await s.expect("changed nothing");
		await s.refute("BLOCKER");
		await s.close();
	});
});
