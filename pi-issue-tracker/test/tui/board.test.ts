// The story board — rendering, arrow navigation, and the four status keys.
//
// A5 is the important one. Closing a story from the board is the only route in
// the whole extension that runs from a keystroke straight to a git commit, and
// nothing below the TUI can exercise it.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getStoryById, getStoryCommit } from "../../src/database.ts";
import { session } from "./pi-session.ts";

describe("/stories board", () => {
	it("A1 opens, shows the tree and the open count", async (t) => {
		const s = await session(t, "stories");
		await s.command("/stories");
		await s.expect("Story Board");
		await s.expect("4 open");
		await s.expect("Ship the widget");

		// The children are indented under their epic: two columns for the row
		// prefix, two more for depth 1. Checked on the unnormalised output,
		// because indentation is exactly what collapsing whitespace destroys.
		assert.match(s.rawScreen(), /\n {4}\[draft\] #2 Add the widget model/, "children are indented under the epic");
		assert.match(s.rawScreen(), /▾ \[draft\] #1 Ship the widget/, "the epic is marked as having children");

		await s.press("[Escape]");
		await s.close();
	});

	it("A2 keys r and s set ready and in_progress", async (t) => {
		const s = await session(t, "stories");
		const first = s.facts.firstId!;
		await s.command("/stories");
		await s.expect("Story Board");
		await s.press("[ArrowDown]");
		await s.expect(`#${first} Add the widget model`);
		await s.press("r");
		await s.expect(`[ready] #${first}`);
		await s.press("s");
		await s.expect(`[in_progress] #${first}`);
		await s.press("[Escape]");
		await s.close();

		assert.equal(s.db((db) => getStoryById(db, first)?.status), "in_progress", "board key s left the story in_progress");
	});

	it("A3 key d closes with resolution completed", async (t) => {
		const s = await session(t, "stories");
		const first = s.facts.firstId!;
		await s.command("/stories");
		await s.expect("Story Board");
		await s.press("[ArrowDown]");
		await s.press("d");
		await s.expect("Resolution: completed — Closed from the story board.");
		await s.press("[Escape]");
		await s.close();

		const story = s.db((db) => getStoryById(db, first));
		assert.equal(story?.status, "done", "board key d closed the story");
		assert.equal(story?.resolution, "completed", "board key d recorded a resolution");
		assert.equal(story?.resolution_note, "Closed from the story board.", "the board's resolution note is recorded");
	});

	it("A4 key x cancels with resolution wontfix", async (t) => {
		const s = await session(t, "stories");
		const loose = s.facts.looseId!;
		await s.command("/stories");
		await s.expect("Story Board");
		// Past the epic and both of its children, to the standalone story.
		await s.press("[ArrowDown][ArrowDown][ArrowDown]");
		await s.expect(`#${loose} Fix the typo in the readme`);
		await s.press("x");
		await s.expect("Resolution: wontfix");
		await s.press("[Escape]");
		await s.close();

		const story = s.db((db) => getStoryById(db, loose));
		assert.equal(story?.status, "cancelled", "board key x cancelled the story");
		assert.equal(story?.resolution, "wontfix", "board key x recorded wontfix");
	});

	it("A5 key d inside an active epic makes exactly one commit", async (t) => {
		// A clean tree is legitimately nothing to commit, so the story has to have
		// changed something for the commit path to run at all.
		const s = await session(t, "epicActive", {
			prepare: (dir) => writeFileSync(join(dir, "model.ts"), "export const widget = {};\n"),
		});
		const first = s.facts.firstId!;
		const before = await s.count();

		await s.command("/stories");
		await s.expect("Story Board");
		await s.press("[ArrowDown]");
		await s.press("d", { settle: 3000 });
		await s.expect(`[done] #${first}`);
		await s.press("[Escape]");
		await s.close();

		assert.equal(await s.count(), before + 1, "closing a story inside an epic makes exactly one commit");
		assert.match(await s.git("log", "-1", "--pretty=%s"), new RegExp(`#${first}`), "the commit uses the story message format");
		assert.ok(s.db((db) => getStoryCommit(db, first)?.commit_sha), "the story commit is recorded for undo");
	});
});
