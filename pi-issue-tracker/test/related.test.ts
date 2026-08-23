import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { createStory, openDb, updateStory } from "../src/database.ts";
import { keywordStrategy } from "../src/related.ts";
import type { Story } from "../src/types.ts";

/**
 * The relevance strategy that decides what rides on every turn's context.
 *
 * Untested until handoff notes needed a read path — and this is the layer where
 * "the memory accumulates" either works or quietly does nothing, so the
 * `score > 0` filter and the structural boosts are pinned here.
 */

const dirs: string[] = [];
function tempDb() {
	const dir = mkdtempSync(join(tmpdir(), "pi-tracker-rel-"));
	dirs.push(dir);
	return openDb(join(dir, ".pi", "stories.db"));
}
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let priority = 0;
function make(db: DatabaseSync, overrides: Partial<Story> & { title: string }): Story {
	return createStory(db, {
		sub_goal: "",
		proposed_changes: "",
		status: "draft",
		priority: ++priority,
		parent_id: null,
		next_id: null,
		depends_on: [],
		...overrides,
	});
}

describe("findRelated", () => {
	it("returns nothing when there is nothing else open", () => {
		const db = tempDb();
		const only = make(db, { title: "Rate limiting" });
		assert.deepEqual(keywordStrategy.findRelated(db, only, 5), []);
	});

	it("scores word overlap and excludes the story itself", () => {
		const db = tempDb();
		const target = make(db, { title: "Add rate limiting", sub_goal: "throttle requests" });
		make(db, { title: "Rate limiting docs", sub_goal: "document throttle behaviour" });
		make(db, { title: "Unrelated colour picker" });
		const found = keywordStrategy.findRelated(db, target, 5);
		assert.equal(found[0].title, "Rate limiting docs");
		assert.ok(!found.some((s) => s.id === target.id), "never returns the story itself");
	});

	it("excludes closed stories — that is what findLearnings is for", () => {
		const db = tempDb();
		const target = make(db, { title: "Add rate limiting" });
		const closed = make(db, { title: "Rate limiting spike" });
		updateStory(db, closed.id, { status: "done" });
		assert.deepEqual(keywordStrategy.findRelated(db, target, 5), []);
	});

	it("honours the limit", () => {
		const db = tempDb();
		const target = make(db, { title: "Add rate limiting" });
		for (let i = 0; i < 5; i++) make(db, { title: `Rate limiting part ${i}` });
		assert.equal(keywordStrategy.findRelated(db, target, 2).length, 2);
	});
});

describe("findLearnings", () => {
	it("returns only stories that recorded one", () => {
		const db = tempDb();
		const target = make(db, { title: "Add rate limiting" });
		const withLearning = make(db, { title: "Rate limiting spike" });
		make(db, { title: "Rate limiting docs" });
		updateStory(db, withLearning.id, { status: "done", learnings: "the limiter is per-process" });
		const found = keywordStrategy.findLearnings(db, target, 5);
		assert.equal(found.length, 1);
		assert.equal(found[0].id, withLearning.id);
	});

	// The filter that keeps unrelated noise out of every turn's context.
	it("drops candidates with no connection at all", () => {
		const db = tempDb();
		const target = make(db, { title: "Add rate limiting" });
		const unrelated = make(db, { title: "Colour picker" });
		updateStory(db, unrelated.id, { status: "done", learnings: "swatches are hard" });
		assert.deepEqual(keywordStrategy.findLearnings(db, target, 5), []);
	});

	it("keeps a sibling under the same epic even with no word overlap", () => {
		const db = tempDb();
		const epic = make(db, { title: "An epic" });
		const target = make(db, { title: "Add rate limiting", parent_id: epic.id });
		const sibling = make(db, { title: "Colour picker", parent_id: epic.id });
		updateStory(db, sibling.id, { status: "done", learnings: "swatches are hard" });
		const found = keywordStrategy.findLearnings(db, target, 5);
		assert.equal(found.length, 1, "a sibling is relevant by structure, not by vocabulary");
	});
});

describe("findHandoffs", () => {
	it("returns only stories carrying a handoff note", () => {
		const db = tempDb();
		const target = make(db, { title: "Add rate limiting" });
		const handed = make(db, { title: "Rate limiting spike" });
		make(db, { title: "Rate limiting docs" });
		updateStory(db, handed.id, { status: "done", handoff_notes: "the limiter lives in src/limiter.ts" });
		const found = keywordStrategy.findHandoffs(db, target, 5);
		assert.equal(found.length, 1);
		assert.equal(found[0].id, handed.id);
	});

	it("excludes an empty note, so a blank string is not memory", () => {
		const db = tempDb();
		const target = make(db, { title: "Add rate limiting" });
		const blank = make(db, { title: "Rate limiting spike" });
		updateStory(db, blank.id, { status: "done", handoff_notes: "   " });
		assert.deepEqual(keywordStrategy.findHandoffs(db, target, 5), []);
	});

	/**
	 * The note is what makes a handoff worth retrieving — it names the things the
	 * plan did not. Scoring on the story's own text alone would miss exactly the
	 * cases the field exists for.
	 */
	it("matches on the note's text, not only the story's plan", () => {
		const db = tempDb();
		const target = make(db, { title: "Fix the limiter", sub_goal: "the throttle is wrong" });
		const other = make(db, { title: "Colour picker", sub_goal: "pick colours" });
		updateStory(db, other.id, {
			status: "done",
			handoff_notes: "while here I noticed the throttle is keyed by IP",
		});
		const found = keywordStrategy.findHandoffs(db, target, 5);
		assert.equal(found.length, 1, "the note itself carries the connection");
	});

	it("drops candidates with no connection at all", () => {
		const db = tempDb();
		const target = make(db, { title: "Add rate limiting" });
		const unrelated = make(db, { title: "Colour picker" });
		updateStory(db, unrelated.id, { status: "done", handoff_notes: "swatches are hard" });
		assert.deepEqual(keywordStrategy.findHandoffs(db, target, 5), []);
	});

	// Unlike findLearnings, which is about closed work only.
	it("includes an open story's note — that is what picking up work needs", () => {
		const db = tempDb();
		const target = make(db, { title: "Add rate limiting" });
		const inFlight = make(db, { title: "Rate limiting groundwork", status: "in_progress" });
		updateStory(db, inFlight.id, { handoff_notes: "half done; the config parser is the blocker" });
		const found = keywordStrategy.findHandoffs(db, target, 5);
		assert.equal(found.length, 1);
	});

	it("excludes the story's own note", () => {
		const db = tempDb();
		const target = make(db, { title: "Add rate limiting" });
		updateStory(db, target.id, { handoff_notes: "rate limiting notes" });
		const refetched = { ...target, handoff_notes: "rate limiting notes" };
		assert.deepEqual(keywordStrategy.findHandoffs(db, refetched, 5), []);
	});

	it("honours the limit", () => {
		const db = tempDb();
		const target = make(db, { title: "Add rate limiting" });
		for (let i = 0; i < 5; i++) {
			const s = make(db, { title: `Rate limiting part ${i}` });
			updateStory(db, s.id, { status: "done", handoff_notes: `note about rate limiting ${i}` });
		}
		assert.equal(keywordStrategy.findHandoffs(db, target, 2).length, 2);
	});
});
