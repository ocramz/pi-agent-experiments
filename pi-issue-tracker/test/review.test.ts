import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideReview, SELF_REVIEW } from "../src/review.ts";
import type { ReviewFinding } from "../src/rules.ts";
import type { Story } from "../src/types.ts";
import { createStubReviewer, stubVerdict } from "./helpers/repo.ts";

/**
 * The review decision, with and without a second model.
 *
 * This is where the independence rules are pinned. The live tier can only prove
 * the wiring — that a second model is reached at all — because a real reviewer
 * is neither free nor deterministic. Every *rule* it enforces is checked here,
 * against a stub, for nothing.
 */

function story(overrides: Partial<Story> = {}): Story {
	return {
		id: 12,
		title: "Add auth",
		sub_goal: "Users can sign in",
		proposed_changes: "add a login route",
		status: "ready",
		priority: 0,
		parent_id: 9,
		next_id: null,
		depends_on: [],
		resolution: null,
		resolution_note: null,
		learnings: null,
		review: {},
		handoff_notes: null,
		created_at: 0,
		updated_at: 0,
		...overrides,
	};
}

const BLOCKER: ReviewFinding[] = [{ severity: "blocker", message: "dependency cycle: #1 → #2 → #1" }];
const NOTE: ReviewFinding[] = [{ severity: "note", message: "proposed_changes is thin" }];

const at = () => 1_700_000_000_000;

describe("decideReview — self-review", () => {
	it("reports the findings and records nothing when no verdict is given", async () => {
		const outcome = await decideReview({ gate: "plan", story: story(), findings: NOTE, reviewer: null, now: at });
		assert.equal(outcome.ok, false);
		assert.match(outcome.ok === false ? outcome.report : "", /no verdict recorded yet/);
		assert.match(outcome.ok === false ? outcome.report : "", /proposed_changes is thin/);
	});

	it("tells the agent a blocker cannot be approved, on the report call", async () => {
		const outcome = await decideReview({ gate: "plan", story: story(), findings: BLOCKER, reviewer: null, now: at });
		assert.equal(outcome.ok, false);
		assert.match(outcome.ok === false ? outcome.report : "", /At least one BLOCKER stands/);
	});

	it("records an approval when nothing blocks", async () => {
		const outcome = await decideReview({
			gate: "plan",
			story: story(),
			findings: NOTE,
			reviewer: null,
			selfVerdict: "approved",
			selfFindings: "scope is one commit's worth",
			now: at,
		});
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.record.verdict, "approved");
		assert.equal(outcome.record.by, SELF_REVIEW);
		assert.equal(outcome.record.at, at());
		// Both halves survive: the mechanical findings and the agent's own reasoning.
		assert.match(outcome.record.findings, /proposed_changes is thin/);
		assert.match(outcome.record.findings, /scope is one commit's worth/);
	});

	// The rule that stops self-review being a rubber stamp.
	it("refuses to approve past a mechanical blocker", async () => {
		const outcome = await decideReview({
			gate: "plan",
			story: story(),
			findings: BLOCKER,
			reviewer: null,
			selfVerdict: "approved",
			now: at,
		});
		assert.equal(outcome.ok, false);
		assert.match(outcome.ok === false ? outcome.report : "", /Cannot approve #12: a blocker stands/);
	});

	it("records changes_requested even when a blocker stands — that is the honest verdict", async () => {
		const outcome = await decideReview({
			gate: "work",
			story: story(),
			findings: BLOCKER,
			reviewer: null,
			selfVerdict: "changes_requested",
			now: at,
		});
		assert.equal(outcome.ok, true);
		assert.equal(outcome.ok === true ? outcome.record.verdict : "", "changes_requested");
	});
});

describe("decideReview — independent reviewer", () => {
	it("records the reviewer's verdict, attributed to its model", async () => {
		const reviewer = stubVerdict("approved", "scope is clear", "anthropic/claude-sonnet-5");
		const outcome = await decideReview({ gate: "plan", story: story(), findings: NOTE, reviewer, now: at });
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.record.verdict, "approved");
		assert.equal(outcome.record.by, "anthropic/claude-sonnet-5");
		assert.notEqual(outcome.record.by, SELF_REVIEW);
		assert.match(outcome.record.findings, /scope is clear/);
	});

	it("records changes_requested from the reviewer", async () => {
		const outcome = await decideReview({
			gate: "work",
			story: story(),
			findings: NOTE,
			reviewer: stubVerdict("changes_requested", "the error path is untested"),
			now: at,
		});
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.record.verdict, "changes_requested");
		assert.match(outcome.record.findings, /the error path is untested/);
	});

	// Strict independence: the agent that wrote the code does not grade it.
	it("refuses a verdict from the working agent", async () => {
		const reviewer = stubVerdict("approved");
		const outcome = await decideReview({
			gate: "plan",
			story: story(),
			findings: NOTE,
			reviewer,
			selfVerdict: "approved",
			now: at,
		});
		assert.equal(outcome.ok, false);
		assert.match(outcome.ok === false ? outcome.report : "", /not yours to set/);
		assert.equal(reviewer.calls.length, 0, "the reviewer is not even consulted — the call is malformed");
	});

	// A second model is not licence to override a mechanical fact either.
	it("downgrades an approval that a blocker contradicts", async () => {
		const outcome = await decideReview({
			gate: "plan",
			story: story(),
			findings: BLOCKER,
			reviewer: stubVerdict("approved", "looks fine to me"),
			now: at,
		});
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.record.verdict, "changes_requested");
		assert.match(outcome.record.findings, /a mechanical blocker stands/);
	});

	it("records nothing when the reviewer cannot be reached — the gate stays shut", async () => {
		const outcome = await decideReview({
			gate: "plan",
			story: story(),
			findings: NOTE,
			reviewer: createStubReviewer({ ok: false, error: "connect ECONNREFUSED" }),
			now: at,
		});
		assert.equal(outcome.ok, false);
		assert.match(outcome.ok === false ? outcome.report : "", /could not be reached: connect ECONNREFUSED/);
		assert.match(outcome.ok === false ? outcome.report : "", /still unreviewed/);
	});

	it("records nothing when the reviewer returns prose instead of a verdict", async () => {
		const outcome = await decideReview({
			gate: "plan",
			story: story(),
			findings: NOTE,
			reviewer: createStubReviewer({ ok: true, model: "m", text: "Sure! I think this looks great." }),
			now: at,
		});
		assert.equal(outcome.ok, false);
		assert.match(outcome.ok === false ? outcome.report : "", /did not return a usable verdict/);
	});

	it("records nothing when the reviewer invents a verdict outside the vocabulary", async () => {
		const outcome = await decideReview({
			gate: "plan",
			story: story(),
			findings: NOTE,
			reviewer: createStubReviewer({ ok: true, model: "m", text: '{"verdict":"lgtm","findings":"fine"}' }),
			now: at,
		});
		assert.equal(outcome.ok, false);
	});

	it("tolerates a fenced reply, which is what models actually send", async () => {
		const outcome = await decideReview({
			gate: "plan",
			story: story(),
			findings: NOTE,
			reviewer: createStubReviewer({
				ok: true,
				model: "m",
				text: 'Here is my review:\n```json\n{"verdict":"approved","findings":"fine"}\n```\nHope that helps!',
			}),
			now: at,
		});
		assert.equal(outcome.ok, true);
		assert.equal(outcome.ok === true ? outcome.record.verdict : "", "approved");
	});

	it("shows the reviewer the story, the mechanical findings and the evidence", async () => {
		const reviewer = stubVerdict("approved");
		await decideReview({
			gate: "work",
			story: story({ depends_on: [3] }),
			findings: BLOCKER,
			reviewer,
			evidence: "Files changed (1):\n  src/limiter.ts",
			now: at,
		});
		const [req] = reviewer.calls;
		assert.match(req.prompt, /Story #12: Add auth/);
		assert.match(req.prompt, /Depends on: #3/);
		assert.match(req.prompt, /dependency cycle/);
		assert.match(req.prompt, /src\/limiter\.ts/);
		// The reviewer is told it has no stake in approving, and asked for JSON only.
		assert.match(req.systemPrompt, /no stake in approving/);
		assert.match(req.systemPrompt, /ONLY a JSON object/);
	});

	it("asks a plan reviewer and a work reviewer different questions", async () => {
		const plan = stubVerdict("approved");
		const work = stubVerdict("approved");
		await decideReview({ gate: "plan", story: story(), findings: [], reviewer: plan, now: at });
		await decideReview({ gate: "work", story: story(), findings: [], reviewer: work, now: at });
		assert.match(plan.calls[0].systemPrompt, /worth starting AS WRITTEN/);
		assert.match(work.calls[0].systemPrompt, /satisfies the story/);
	});

	it("passes the abort signal through, so a user abort kills the review", async () => {
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		const reviewer = createStubReviewer(() => ({ ok: true, model: "m", text: '{"verdict":"approved","findings":""}' }));
		const wrapped = async (req: Parameters<typeof reviewer>[0], signal?: AbortSignal) => {
			seen = signal;
			return reviewer(req, signal);
		};
		await decideReview({ gate: "plan", story: story(), findings: [], reviewer: wrapped, signal: controller.signal, now: at });
		assert.equal(seen, controller.signal);
	});
});
