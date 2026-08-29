import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { getAllStories, getAppState, getStoryById } from "../src/database.ts";
import {
	coercePlanItems,
	parsePlanResponse,
	persistPlan,
	planSystemPrompt,
	planUserContent,
	repairStoryGraph,
} from "../src/plan.ts";
import { createTempRepo, type TempRepo } from "./helpers/repo.ts";

/**
 * The `/plan-stories` pipeline.
 *
 * Untested until it moved out of `extensions/index.ts`: a command handler is
 * reachable only from pi's TUI, so every branch below — including the ones that
 * decide whether a whole plan is kept, repaired or discarded — was previously
 * covered by nothing but a live model that had to choose to exercise it.
 */

describe("planSystemPrompt", () => {
	it("leaves earlier turns free to ask questions", () => {
		const prompt = planSystemPrompt(0, 3);
		assert.ok(prompt.includes(">>> CLARIFY:"));
		assert.ok(!prompt.includes("final chance"));
	});

	it("forbids a question on the last turn, because there is no turn left to answer it", () => {
		const prompt = planSystemPrompt(2, 3);
		assert.ok(prompt.includes("This is your final chance"));
		assert.ok(prompt.includes("Produce the JSON array directly"));
	});
});

describe("planUserContent", () => {
	it("sends the bare goal when nothing has been clarified", () => {
		assert.equal(planUserContent("add search", null), "add search");
	});

	it("restates the goal above the answers, so the model sees both", () => {
		const content = planUserContent("add search", ["Which index?\nAnswer: sqlite FTS"]);
		assert.ok(content.startsWith("Goal: add search"));
		assert.ok(content.includes("Clarifications:\nWhich index?\nAnswer: sqlite FTS"));
	});
});

describe("coercePlanItems", () => {
	const one = [{ title: "T", sub_goal: "G", proposed_changes: "C" }];

	it("accepts a well-formed array", () => {
		const items = coercePlanItems(one);
		assert.equal(items?.length, 1);
		assert.deepEqual(items?.[0], {
			title: "T",
			sub_goal: "G",
			proposed_changes: "C",
			depends_on: [],
			parent_index: null,
		});
	});

	it("trims the two fields it requires", () => {
		const items = coercePlanItems([{ title: "  T  ", sub_goal: "\tG\n" }]);
		assert.equal(items?.[0].title, "T");
		assert.equal(items?.[0].sub_goal, "G");
	});

	it("defaults proposed_changes rather than rejecting the item", () => {
		assert.equal(coercePlanItems([{ title: "T", sub_goal: "G" }])?.[0].proposed_changes, "");
	});

	it("rejects a non-array", () => {
		assert.equal(coercePlanItems({ title: "T", sub_goal: "G" }), null);
	});

	it("rejects an empty array — a plan with no stories is not a plan", () => {
		assert.equal(coercePlanItems([]), null);
	});

	it("rejects the whole plan when any item is missing a required field", () => {
		assert.equal(coercePlanItems([...one, { title: "T2" }]), null);
		assert.equal(coercePlanItems([...one, { sub_goal: "G2" }]), null);
	});

	it("rejects a blank title or sub-goal, which SQLite would accept and nobody could read", () => {
		assert.equal(coercePlanItems([{ title: "   ", sub_goal: "G" }]), null);
		assert.equal(coercePlanItems([{ title: "T", sub_goal: "" }]), null);
	});

	it("rejects a non-object entry", () => {
		assert.equal(coercePlanItems(["just a string"]), null);
		assert.equal(coercePlanItems([null]), null);
	});

	it("drops non-numeric dependency entries instead of failing the plan", () => {
		const items = coercePlanItems([{ title: "T", sub_goal: "G", depends_on: [0, "x", 1] }]);
		assert.deepEqual(items?.[0].depends_on, [0, 1]);
	});

	it("treats a non-numeric parent_index as absent", () => {
		assert.equal(coercePlanItems([{ title: "T", sub_goal: "G", parent_index: "0" }])?.[0].parent_index, null);
	});
});

describe("repairStoryGraph", () => {
	const item = (title: string, extra: Record<string, unknown> = {}) => ({
		title,
		sub_goal: "G",
		proposed_changes: "",
		depends_on: [],
		parent_index: null,
		...extra,
	});

	it("leaves a well-formed graph alone and warns about nothing", () => {
		const { items, warnings } = repairStoryGraph([item("a"), item("b", { parent_index: 0, depends_on: [0] })]);
		assert.deepEqual(warnings, []);
		assert.equal(items[1].parent_index, 0);
		assert.deepEqual(items[1].depends_on, [0]);
	});

	it("re-parents a forward reference to the goal, keeping the story", () => {
		const { items, warnings } = repairStoryGraph([item("a", { parent_index: 1 }), item("b")]);
		assert.equal(items[0].parent_index, null);
		assert.equal(items.length, 2);
		assert.match(warnings[0], /"a" had parent_index 1; re-parented to the goal\./);
	});

	it("re-parents a self-reference — parent_index must point strictly backwards", () => {
		const { items } = repairStoryGraph([item("a"), item("b", { parent_index: 1 })]);
		assert.equal(items[1].parent_index, null);
	});

	it("re-parents a negative index", () => {
		const { items, warnings } = repairStoryGraph([item("a", { parent_index: -1 })]);
		assert.equal(items[0].parent_index, null);
		assert.equal(warnings.length, 1);
	});

	it("drops a forward dependency and keeps the rest", () => {
		const { items, warnings } = repairStoryGraph([item("a"), item("b"), item("c", { depends_on: [0, 5, 1] })]);
		assert.deepEqual(items[2].depends_on, [0, 1]);
		assert.match(warnings[0], /"c" dropped out-of-range dependency 5\./);
	});

	it("drops a negative dependency", () => {
		const { items } = repairStoryGraph([item("a", { depends_on: [-1] })]);
		assert.deepEqual(items[0].depends_on, []);
	});

	it("truncates a long title in the warning, so one bad item cannot flood the notification", () => {
		const { warnings } = repairStoryGraph([item("x".repeat(80), { parent_index: 3 })]);
		assert.ok(warnings[0].includes("…"));
		assert.ok(warnings[0].length < 120);
	});
});

describe("parsePlanResponse", () => {
	const plan = '[{"title":"T","sub_goal":"G"}]';

	it("reads a bare JSON array as a plan", () => {
		const parsed = parsePlanResponse(plan);
		assert.equal(parsed.kind, "plan");
		assert.equal(parsed.kind === "plan" && parsed.items.length, 1);
	});

	it("reads a fenced array as a plan", () => {
		assert.equal(parsePlanResponse("```json\n" + plan + "\n```").kind, "plan");
	});

	it("reads a dash list of questions as a clarification", () => {
		const parsed = parsePlanResponse(">>> CLARIFY:\n- Which database?\n- Which auth?");
		assert.equal(parsed.kind, "clarify");
		assert.deepEqual(parsed.kind === "clarify" && parsed.questions, ["Which database?", "Which auth?"]);
	});

	it("reads a numbered list of questions too", () => {
		const parsed = parsePlanResponse(">>> CLARIFY:\n1. Which database?\n2. Which auth?");
		assert.deepEqual(parsed.kind === "clarify" && parsed.questions, ["Which database?", "Which auth?"]);
	});

	/**
	 * The subtle branch. A reply that announces questions and then lists none we
	 * recognise is a malformed clarification, not a refusal — and the JSON may
	 * still be sitting right there. Reporting an error instead would throw away a
	 * usable plan.
	 */
	it("falls through to a plan when CLARIFY is announced but no question is recognisable", () => {
		const parsed = parsePlanResponse(">>> CLARIFY: actually never mind\n" + plan);
		assert.equal(parsed.kind, "plan");
	});

	it("reports the announced-clarify failure separately, because the two read differently to a user", () => {
		const announced = parsePlanResponse(">>> CLARIFY: never mind, here is nothing");
		assert.equal(announced.kind, "unparseable");
		assert.equal(announced.kind === "unparseable" && announced.announcedClarify, true);

		const plain = parsePlanResponse("I would rather not.");
		assert.equal(plain.kind, "unparseable");
		assert.equal(plain.kind === "unparseable" && plain.announcedClarify, false);
	});

	it("is unparseable when the array is well-formed JSON of the wrong shape", () => {
		assert.equal(parsePlanResponse('[{"name":"T"}]').kind, "unparseable");
	});

	it("is unparseable on an empty array — coercePlanItems refuses a plan with no stories", () => {
		assert.equal(parsePlanResponse("[]").kind, "unparseable");
	});
});

describe("persistPlan", () => {
	let repo: TempRepo;
	let db: DatabaseSync;

	before(async () => {
		repo = await createTempRepo();
		db = repo.db;
	});
	after(() => repo.cleanup());

	const items = [
		{ title: "one", sub_goal: "G1", proposed_changes: "C1", depends_on: [], parent_index: null },
		{ title: "two", sub_goal: "G2", proposed_changes: "C2", depends_on: [0], parent_index: null },
		{ title: "three", sub_goal: "G3", proposed_changes: "C3", depends_on: [], parent_index: 0 },
	];

	it("materialises the goal as the root epic every story hangs from", () => {
		const { rootId, createdIds } = persistPlan(db, "add full-text search", items);
		const root = getStoryById(db, rootId)!;
		assert.equal(root.title, "add full-text search");
		assert.equal(root.sub_goal, "add full-text search");
		assert.equal(root.parent_id, null);
		assert.equal(createdIds.length, 3);
		// #1 and #2 default to the root; #3 named index 0 as its parent.
		assert.equal(getStoryById(db, createdIds[0])!.parent_id, rootId);
		assert.equal(getStoryById(db, createdIds[1])!.parent_id, rootId);
		assert.equal(getStoryById(db, createdIds[2])!.parent_id, createdIds[0]);
	});

	it("truncates a long goal into the title but keeps it whole in the sub-goal", () => {
		const goal = "g".repeat(200);
		const { rootId } = persistPlan(db, goal, items.slice(0, 1));
		const root = getStoryById(db, rootId)!;
		assert.equal(root.title.length, 81); // 80 + the ellipsis
		assert.equal(root.sub_goal, goal);
	});

	it("chains the children with next_id and leaves the root out of the chain", () => {
		const { rootId, createdIds } = persistPlan(db, "chain", items);
		assert.equal(getStoryById(db, createdIds[0])!.next_id, createdIds[1]);
		assert.equal(getStoryById(db, createdIds[1])!.next_id, createdIds[2]);
		assert.equal(getStoryById(db, createdIds[2])!.next_id, null);
		assert.equal(getStoryById(db, rootId)!.next_id, null);
	});

	it("resolves dependency indices to the ids they turned into", () => {
		const { createdIds } = persistPlan(db, "deps", items);
		assert.deepEqual(getStoryById(db, createdIds[1])!.depends_on, [createdIds[0]]);
	});

	/**
	 * Without this the whole plan sits in `draft` and the injected context reports
	 * NO ACTIVE WORK — the model is handed a plan it has no instruction to start.
	 */
	it("promotes the first dependency-free story to ready, and only that one", () => {
		const { rootId, createdIds } = persistPlan(db, "ready", items);
		assert.equal(getStoryById(db, createdIds[0])!.status, "ready");
		assert.equal(getStoryById(db, createdIds[1])!.status, "draft");
		assert.equal(getStoryById(db, createdIds[2])!.status, "draft");
		assert.equal(getStoryById(db, rootId)!.status, "draft");
	});

	/**
	 * `repairStoryGraph` already drops out-of-range indices, so in the command's
	 * path this cannot happen. It is guarded here anyway because the alternative
	 * — writing `undefined` into a dependency array — would produce a story
	 * waiting on an id that does not exist, which nothing downstream can detect.
	 *
	 * The consequence is worth stating: index 0 can never name a dependency, so
	 * after this filter there is always at least one dependency-free story and
	 * `persistPlan` always has something to promote to `ready`.
	 */
	it("drops an index that resolves to no story rather than writing a dangling dependency", () => {
		const dangling = [
			{ title: "a", sub_goal: "G", proposed_changes: "", depends_on: [7], parent_index: null },
			{ title: "b", sub_goal: "G", proposed_changes: "", depends_on: [0], parent_index: null },
		];
		const { createdIds } = persistPlan(db, "dangling", dangling);
		assert.deepEqual(getStoryById(db, createdIds[0])!.depends_on, []);
		assert.deepEqual(getStoryById(db, createdIds[1])!.depends_on, [createdIds[0]]);
		assert.equal(getStoryById(db, createdIds[0])!.status, "ready");
	});

	it("falls back to the root when parent_index resolves to no story", () => {
		const dangling = [{ title: "a", sub_goal: "G", proposed_changes: "", depends_on: [], parent_index: 9 }];
		const { rootId, createdIds } = persistPlan(db, "dangling parent", dangling);
		assert.equal(getStoryById(db, createdIds[0])!.parent_id, rootId);
	});

	it("records the root as the top-level story, so the big-picture block has something to show", () => {
		const { rootId } = persistPlan(db, "top level", items);
		assert.equal(getAppState(db, "top_level_story_id"), String(rootId));
	});

	/**
	 * Priority is where a second run lands relative to the first. Restarting at 0
	 * would interleave two unrelated plans on the board.
	 */
	it("stacks a second plan after the first instead of restarting the ordering", () => {
		const first = persistPlan(db, "first", items);
		const second = persistPlan(db, "second", items);
		const priority = (id: number) => getStoryById(db, id)!.priority;
		assert.ok(priority(second.rootId) > priority(first.createdIds.at(-1)!));
		assert.ok(priority(second.createdIds[0]) > priority(second.rootId));
	});

	it("writes every story in one transaction — nothing half-created survives", () => {
		const before = getAllStories(db).length;
		persistPlan(db, "atomic", items);
		assert.equal(getAllStories(db).length, before + items.length + 1);
	});
});
