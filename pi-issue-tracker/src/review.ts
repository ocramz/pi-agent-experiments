import type { ReviewerRunner, ReviewUsage } from "./context.ts";
import { getAllStories, getChildren } from "./database.ts";
import { collectWorkEvidence, findEpicForStory } from "./epic.ts";
import { parseJsonObject } from "./json.ts";
import { formatFindings, hasBlocker, reviewPlan, reviewWork, type ReviewFinding } from "./rules.ts";
import { serializeGit, type TrackerSession } from "./session.ts";
import { REVIEW_VERDICTS, type ReviewRecord, type ReviewVerdict, type Story } from "./types.ts";

/**
 * Deciding a review, with or without a second model.
 *
 * Two rules hold whichever path runs, and they are what make a review worth
 * more than a rubber stamp:
 *
 *  1. **A blocker cannot be approved past.** The mechanical findings in
 *     `src/rules.ts` are facts — the story is an epic, its dependencies cycle,
 *     `verify` failed. No judge overrides one.
 *  2. **When a reviewer is configured, the verdict is not the working agent's
 *     to set.** The agent that wrote the code does not get to grade it, and a
 *     reviewer that fails records nothing rather than quietly handing the
 *     decision back — silent degradation to self-certification would make the
 *     whole feature a lie.
 *
 * Nothing here imports from `@earendil-works/*`: the reviewer arrives as an
 * injected `ReviewerRunner`, so every branch below is testable with a stub.
 */

/** Which gate is being reviewed. */
export type ReviewGate = "plan" | "work";

/** Recorded when no independent reviewer is configured. */
export const SELF_REVIEW = "self";

export type ReviewOutcome =
	| { ok: true; record: ReviewRecord; usage?: ReviewUsage }
	/** Nothing was recorded. `report` is what to tell the caller. */
	| { ok: false; report: string; usage?: ReviewUsage };

export interface DecideReviewInput {
	gate: ReviewGate;
	story: Story;
	findings: ReviewFinding[];
	/** Null for self-review. */
	reviewer: ReviewerRunner | null;
	/** The working agent's verdict. Only honoured when `reviewer` is null. */
	selfVerdict?: ReviewVerdict;
	/** The working agent's own reasoning, when self-reviewing. */
	selfFindings?: string;
	/** Extra context for the reviewer model — the diff, the manifest's verify output. */
	evidence?: string;
	now: () => number;
	signal?: AbortSignal;
}

export async function decideReview(input: DecideReviewInput): Promise<ReviewOutcome> {
	const { gate, story, findings, reviewer, now } = input;
	const mechanical = formatFindings(findings);
	const blocked = hasBlocker(findings);

	if (reviewer) {
		if (input.selfVerdict) {
			return {
				ok: false,
				report:
					`A reviewer model is configured, so the verdict is not yours to set.\n` +
					`Call story{action:"review_${gate}", story_id:${story.id}} with no verdict and the reviewer will decide.`,
			};
		}
		return askReviewer({ ...input, mechanical, blocked });
	}

	// Self-review. Without a verdict this is the report step: run the checks and
	// hand them back so the agent can judge on the next call.
	if (!input.selfVerdict) {
		return {
			ok: false,
			report:
				`${gateTitle(gate)} review of #${story.id} — no verdict recorded yet.\n\n${mechanical}\n\n` +
				(blocked
					? `At least one BLOCKER stands, so this cannot be approved. Fix it, then review again.`
					: `Call review_${gate} again with verdict and findings to record your judgement.`),
		};
	}

	if (input.selfVerdict === "approved" && blocked) {
		return { ok: false, report: `Cannot approve #${story.id}: a blocker stands.\n\n${mechanical}` };
	}

	return {
		ok: true,
		record: {
			verdict: input.selfVerdict,
			findings: joinFindings(mechanical, input.selfFindings),
			by: SELF_REVIEW,
			at: now(),
		},
	};
}

async function askReviewer(
	input: DecideReviewInput & { mechanical: string; blocked: boolean },
): Promise<ReviewOutcome> {
	const { gate, story, reviewer, mechanical, blocked, now } = input;

	const reply = await reviewer!(
		{
			systemPrompt: reviewerSystemPrompt(gate),
			prompt: reviewerPrompt(gate, story, mechanical, input.evidence),
		},
		input.signal,
	);

	if (!reply.ok) {
		// Deliberately records nothing: the gate stays shut. A reviewer that
		// cannot be reached is not an approval.
		return {
			ok: false,
			report:
				`The reviewer model could not be reached: ${reply.error}\n` +
				`Nothing was recorded and #${story.id} is still unreviewed. Retry, or unset the reviewer to self-review.`,
		};
	}

	const parsed = parseReviewerReply(reply.text);
	if (!parsed) {
		return {
			ok: false,
			usage: reply.usage,
			report:
				`The reviewer model did not return a usable verdict.\n` +
				`Expected {"verdict":"approved"|"changes_requested","findings":"..."}, got:\n${reply.text.trim().slice(0, 500)}`,
		};
	}

	// Rule 1 applies to the reviewer too — a second model is not licence to
	// approve past a mechanical fact.
	const verdict: ReviewVerdict = parsed.verdict === "approved" && blocked ? "changes_requested" : parsed.verdict;
	const overridden =
		verdict !== parsed.verdict ? "\n\n(Reviewer approved, but a mechanical blocker stands — recorded as changes_requested.)" : "";

	return {
		ok: true,
		usage: reply.usage,
		record: {
			verdict,
			findings: joinFindings(mechanical, parsed.findings) + overridden,
			by: reply.model,
			at: now(),
		},
	};
}

function parseReviewerReply(text: string): { verdict: ReviewVerdict; findings: string } | null {
	const parsed = parseJsonObject(text);
	if (!parsed) return null;
	const verdict = parsed.verdict;
	if (typeof verdict !== "string" || !(REVIEW_VERDICTS as readonly string[]).includes(verdict)) return null;
	const findings = typeof parsed.findings === "string" ? parsed.findings.trim() : "";
	return { verdict: verdict as ReviewVerdict, findings };
}

function joinFindings(mechanical: string, judgement: string | undefined): string {
	const own = judgement?.trim();
	return own ? `${mechanical}\n\n${own}` : mechanical;
}

function gateTitle(gate: ReviewGate): string {
	return gate === "plan" ? "Plan" : "Work";
}

function reviewerSystemPrompt(gate: ReviewGate): string {
	const focus =
		gate === "plan"
			? "Judge whether this story is worth starting AS WRITTEN: is it one coherent unit of work, is it sized to a single commit, is its scope clear enough to act on, and is it linked into the story graph correctly?"
			: "Judge whether the work in the working tree satisfies the story: does it do what the sub-goal asked, is anything obviously missing or broken, and does it stay within the story's scope?";
	return (
		`You are reviewing another agent's work in an issue tracker. You did not write it and you have no stake in approving it.\n\n` +
		`${focus}\n\n` +
		`Mechanical checks have already run and are given to you. Do not repeat them; add what only a reader can see. ` +
		`Approve when the work is good enough to proceed — you are a reviewer, not a perfectionist. Request changes when something ` +
		`concrete is wrong, and say exactly what.\n\n` +
		`Reply with ONLY a JSON object, no prose and no code fence:\n` +
		`{"verdict": "approved" | "changes_requested", "findings": "one short paragraph"}`
	);
}

function reviewerPrompt(gate: ReviewGate, story: Story, mechanical: string, evidence?: string): string {
	const parts = [
		`Story #${story.id}: ${story.title}`,
		`Status: ${story.status}`,
		`Sub-goal: ${story.sub_goal}`,
		`Proposed changes: ${story.proposed_changes}`,
	];
	if (story.depends_on.length) parts.push(`Depends on: ${story.depends_on.map((id) => `#${id}`).join(", ")}`);
	if (story.parent_id) parts.push(`Parent epic: #${story.parent_id}`);
	parts.push(`\nMechanical findings:\n${mechanical}`);
	if (evidence?.trim()) parts.push(`\n${evidence.trim()}`);
	parts.push(`\nReview the ${gate === "plan" ? "plan" : "work"} and reply with the JSON object.`);
	return parts.join("\n");
}

/** How many changed files a work review is shown before the list is cut. */
const EVIDENCE_FILES_SHOWN = 50;

/**
 * The mechanical findings for a gate, plus whatever evidence the reviewer
 * should see alongside them.
 *
 * The plan gate reads the board; the work gate reads the working tree, which is
 * why only the second needs an epic and a serialized git call.
 */
export async function gatherFindings(
	session: TrackerSession,
	story: Story,
	gate: ReviewGate,
): Promise<{ findings: ReviewFinding[]; evidence?: string }> {
	const db = session.db;

	if (gate === "plan") {
		return {
			findings: reviewPlan({
				story,
				children: getChildren(db, story.id),
				all: getAllStories(db),
				similar: session.related.findRelated(db, story, 3),
			}),
		};
	}

	const epic = findEpicForStory(session, story.id);
	if (!epic) {
		// No epic means no working tree to inspect and no commit to make. The plan
		// gate still applies; there is simply nothing mechanical to check here.
		return {
			findings: [
				{
					severity: "note",
					message: "this story is not under a started epic, so there is no working tree to review. Ask the user to run /start-epic.",
				},
			],
		};
	}

	const evidence = await serializeGit(session, () => collectWorkEvidence(session, epic));
	const findings = reviewWork({
		story,
		changedFiles: evidence.changedFiles,
		totalBytes: evidence.totalBytes,
		verify: evidence.verify,
	});

	const lines = [
		`Files changed (${evidence.changedFiles.length}):`,
		...evidence.changedFiles.slice(0, EVIDENCE_FILES_SHOWN).map((f) => `  ${f}`),
	];
	if (evidence.changedFiles.length > EVIDENCE_FILES_SHOWN) {
		lines.push(`  … ${evidence.changedFiles.length - EVIDENCE_FILES_SHOWN} more`);
	}
	if (evidence.verify) {
		lines.push(`\nverify (\`${evidence.verify.command}\`): ${evidence.verify.ok ? "passed" : "FAILED"}`);
	}
	return { findings, evidence: lines.join("\n") };
}
