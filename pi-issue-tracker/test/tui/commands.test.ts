// /top-story, /export-stories, and the one /plan-stories case that needs no model.

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getAppState } from "../../src/database.ts";
import { rowCount } from "./inspect.ts";
import { session } from "./session.ts";

describe("/plan-stories without a model", () => {
	it("B2 with no argument shows usage", async (t) => {
		const s = await session(t, "stories");
		const before = s.db((db) => rowCount(db, "stories"));
		await s.command("/plan-stories");
		await s.expect("Usage: /plan-stories <high-level goal>");
		await s.close();

		assert.equal(s.db((db) => rowCount(db, "stories")), before, "a usage error creates no stories");
	});
});

describe("/top-story", () => {
	it("C1 sets the top-level story", async (t) => {
		const s = await session(t, "stories");
		const epic = s.facts.epicId!;
		await s.command(`/top-story ${epic}`);
		await s.expect(`Top-level story set to #${epic}: Ship the widget`);
		await s.close();

		assert.equal(s.db((db) => getAppState(db, "top_level_story_id")), String(epic), "the top-level story is recorded");
	});

	it("C2 rejects an unknown id", async (t) => {
		const s = await session(t, "stories");
		await s.command("/top-story 9999");
		await s.expect("Story #9999 not found");
		await s.close();

		assert.equal(s.db((db) => getAppState(db, "top_level_story_id")), null, "an unknown id sets nothing");
	});
});

describe("/export-stories", () => {
	it("C3 writes stories.md in the working directory", async (t) => {
		const s = await session(t, "stories");
		await s.command("/export-stories");
		await s.expect("Exported 4 stories to");
		await s.close();

		assert.ok(s.exists("stories.md"), "stories.md is written in the working directory");
		const exported = s.read("stories.md");
		assert.match(exported, /Ship the widget/, "the export contains a story heading");
		assert.match(exported, /\*\*Status:\*\*/, "the export records status");
	});

	it("C4 writes to an explicit path", async (t) => {
		// The command writes the file but does not create its directory — the
		// manual brief told the operator to mkdir it first.
		const s = await session(t, "stories", {
			prepare: (dir) => mkdirSync(join(dir, "exported"), { recursive: true }),
		});
		await s.command("/export-stories exported/plan.md");
		await s.expect("exported/plan.md");
		await s.close();

		assert.ok(s.exists("exported/plan.md"), "the export honours an explicit relative path");
	});

	it("C5 warns when there is nothing to export", async (t) => {
		const s = await session(t, "empty");
		await s.command("/export-stories");
		await s.expect("No stories to export");
		await s.close();

		assert.equal(s.exists("stories.md"), false, "an empty database exports nothing");
	});

	/**
	 * The export is one of the read paths that keeps handoff notes from becoming
	 * another write-only table, and the only one a human reads outside the TUI.
	 */
	it("C6 carries review verdicts and handoff notes into the markdown", async (t) => {
		const s = await session(t, "withHandoffs");
		await s.command("/export-stories");
		await s.expect("Exported 4 stories to");
		await s.close();

		const exported = s.read("stories.md");
		assert.match(exported, /\*\*Handoff:\*\* the widget model lives in model\.ts/, "the handoff note is exported");
		assert.match(exported, /\*\*Plan review:\*\* approved — by self/, "the plan verdict is exported");
		assert.match(exported, /\*\*Work review:\*\* approved — by stub\/reviewer-1/, "and who reached it");
	});
});
