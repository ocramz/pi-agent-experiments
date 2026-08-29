import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	backupRefName,
	checkCanClose,
	checkCanMerge,
	checkCanStart,
	checkCanStartEpic,
	checkStageSize,
	checkpointRefPrefix,
	chooseUndoStrategy,
	epicBranchName,
	findCycle,
	formatFindings,
	isBranchEscapingCommand,
	pruneStaleInjections,
	refsToPrune,
	reviewPlan,
	reviewWork,
	slugify,
	storyCommitMessage,
	unmetDependencies,
	worktreeDirName,
	type ActiveEpicSummary,
	type ReviewFinding,
} from "../src/rules.ts";
import type { EpicBranch, Story, StoryCommit } from "../src/types.ts";

function story(overrides: Partial<Story> = {}): Story {
	return {
		id: 12,
		title: "Add auth",
		sub_goal: "Users can sign in",
		proposed_changes: "add a login route",
		status: "ready",
		priority: 0,
		parent_id: null,
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

function active(overrides: Partial<ActiveEpicSummary> = {}): ActiveEpicSummary {
	return { epic_id: 7, mode: "branch", branch: "epic/7-other", path: null, ...overrides };
}

const base = {
	isRepo: true,
	branch: "feat/test",
	dirty: false,
	story: story(),
	childCount: 2,
	mode: "branch" as const,
	activeEpics: [] as ActiveEpicSummary[],
};

describe("checkCanStartEpic", () => {
	it("accepts an epic on a working branch with a clean tree", () => {
		assert.deepEqual(checkCanStartEpic(base), { ok: true });
	});

	it("refuses outside a git repository", () => {
		const result = checkCanStartEpic({ ...base, isRepo: false });
		assert.equal(result.ok, false);
	});

	for (const branch of ["main", "master"]) {
		it(`refuses to start from ${branch}`, () => {
			const result = checkCanStartEpic({ ...base, branch });
			assert.equal(result.ok, false);
			assert.match((result as { reason: string }).reason, new RegExp(branch));
		});
	}

	it("refuses on a detached HEAD", () => {
		const result = checkCanStartEpic({ ...base, branch: null });
		assert.equal(result.ok, false);
		assert.match((result as { reason: string }).reason, /detached/);
	});

	it("refuses a leaf story — an epic is a story with children", () => {
		const result = checkCanStartEpic({ ...base, childCount: 0 });
		assert.equal(result.ok, false);
		assert.match((result as { reason: string }).reason, /unit of work/);
	});

	it("refuses a second branch-mode epic — they would fight over the main checkout", () => {
		const result = checkCanStartEpic({ ...base, activeEpics: [active()] });
		assert.equal(result.ok, false);
		assert.match((result as { reason: string }).reason, /#7/);
		assert.match(
			(result as { reason: string }).reason,
			/--worktree/,
			"the refusal should point at the mode that would have worked",
		);
	});

	it("refuses to restart a story that already has an active epic", () => {
		const result = checkCanStartEpic({ ...base, activeEpics: [active({ epic_id: 12 })] });
		assert.equal(result.ok, false);
		assert.match((result as { reason: string }).reason, /already active/);
	});

	it("refuses a dirty tree, but accepts it once the user agrees to carry it", () => {
		assert.equal(checkCanStartEpic({ ...base, dirty: true }).ok, false);
		assert.equal(checkCanStartEpic({ ...base, dirty: true, carryDirty: true }).ok, true);
	});

	describe("worktree mode", () => {
		const worktree = { ...base, mode: "worktree" as const };

		it("starts alongside any number of other epics, in either mode", () => {
			const others = [
				active({ epic_id: 7, mode: "branch" }),
				active({ epic_id: 8, mode: "worktree", path: "/wt/epic-8" }),
				active({ epic_id: 9, mode: "worktree", path: "/wt/epic-9" }),
			];
			assert.deepEqual(checkCanStartEpic({ ...worktree, activeEpics: others }), { ok: true });
		});

		it("ignores a dirty main tree — worktree add never touches it", () => {
			assert.deepEqual(checkCanStartEpic({ ...worktree, dirty: true }), { ok: true });
		});

		it("refuses when the branch or the directory is already taken", () => {
			const onBranch = checkCanStartEpic({ ...worktree, branchExists: true });
			assert.equal(onBranch.ok, false);
			assert.match((onBranch as { reason: string }).reason, /epic\/12-add-auth/);

			const onPath = checkCanStartEpic({ ...worktree, pathExists: true });
			assert.equal(onPath.ok, false);
			assert.match((onPath as { reason: string }).reason, /epic-12-add-auth/);
		});

		it("still refuses a leaf story and a protected base branch", () => {
			assert.equal(checkCanStartEpic({ ...worktree, childCount: 0 }).ok, false);
			assert.equal(checkCanStartEpic({ ...worktree, branch: "main" }).ok, false);
		});
	});
});

function epic(overrides: Partial<EpicBranch> = {}): EpicBranch {
	return {
		epic_id: 12,
		mode: "worktree",
		branch: "epic/12-add-auth",
		base_branch: "feat/test",
		base_commit: "a".repeat(40),
		path: "/wt/epic-12-add-auth",
		state: "active",
		setup: {},
		created_at: 0,
		updated_at: 0,
		...overrides,
	};
}

describe("checkCanMerge", () => {
	const base = { epic: epic(), baseCheckedOutAt: null, repoRoot: "/repo", mainCheckoutEpicId: null };

	it("accepts when nothing holds the base branch", () => {
		assert.deepEqual(checkCanMerge(base), { ok: true });
	});

	it("accepts when the main checkout holds it — that is where the merge lands", () => {
		assert.deepEqual(checkCanMerge({ ...base, baseCheckedOutAt: "/repo" }), { ok: true });
	});

	it("refuses when another worktree holds the base branch", () => {
		const result = checkCanMerge({ ...base, baseCheckedOutAt: "/wt/epic-9" });
		assert.equal(result.ok, false);
		assert.match((result as { reason: string }).reason, /\/wt\/epic-9/);
	});

	it("refuses to fast-forward past a branch-mode epic occupying the main checkout", () => {
		const result = checkCanMerge({ ...base, mainCheckoutEpicId: 7 });
		assert.equal(result.ok, false);
		assert.match((result as { reason: string }).reason, /#7/);
	});

	it("does not block a branch-mode epic on itself", () => {
		const own = epic({ epic_id: 7, mode: "branch", path: null });
		assert.deepEqual(checkCanMerge({ ...base, epic: own, mainCheckoutEpicId: 7 }), { ok: true });
	});

	it("refuses an epic that already ended", () => {
		assert.equal(checkCanMerge({ ...base, epic: epic({ state: "merged" }) }).ok, false);
	});
});

describe("refsToPrune", () => {
	const prefix = checkpointRefPrefix(3);
	const refs = [1, 2, 3, 4, 5].map((n) => `${prefix}/${1_700_000_000_000 + n}`);

	it("keeps the newest N and returns the rest", () => {
		const doomed = refsToPrune(refs, 2);
		assert.deepEqual(doomed, [
			`${prefix}/1700000000003`,
			`${prefix}/1700000000002`,
			`${prefix}/1700000000001`,
		]);
	});

	it("prunes nothing when there are fewer refs than the limit", () => {
		assert.deepEqual(refsToPrune(refs, 10), []);
	});

	it("orders by the timestamp, not the string, and prunes unparseable names first", () => {
		// A name outside the fixed-width era sorts wrong lexically but right numerically.
		const mixed = [`${prefix}/999`, `${prefix}/1700000000001`, `${prefix}/scratch`];
		assert.deepEqual(refsToPrune(mixed, 1), [`${prefix}/999`, `${prefix}/scratch`]);
	});
});

describe("pruneStaleInjections", () => {
	// The shape the `context` hook hands over: a turn is a user message, the
	// context block injected alongside it, then the assistant's reply.
	const user = (text: string) => ({ role: "user", text });
	const reply = (text: string) => ({ role: "assistant", text });
	const ctx = (text: string) => ({ role: "custom", customType: "story-context", text });

	it("keeps only the newest injection", () => {
		const messages = [
			user("start"),
			ctx("work on #1"),
			reply("done"),
			user("next"),
			ctx("work on #2"),
			reply("done"),
			user("next"),
			ctx("work on #3"),
		];
		assert.deepEqual(pruneStaleInjections(messages, "story-context"), [
			user("start"),
			reply("done"),
			user("next"),
			reply("done"),
			user("next"),
			ctx("work on #3"),
		]);
	});

	it("preserves order and every message it does not own", () => {
		const other = { role: "custom", customType: "other-extension", text: "keep me" };
		const messages = [ctx("stale"), other, user("hi"), ctx("current")];
		assert.deepEqual(pruneStaleInjections(messages, "story-context"), [other, user("hi"), ctx("current")]);
	});

	it("returns the same array by identity when there is nothing to prune", () => {
		// The caller distinguishes on identity to leave the chain untouched, so
		// this is load-bearing rather than an optimisation.
		const messages = [user("hi"), reply("hello")];
		assert.equal(pruneStaleInjections(messages, "story-context"), messages);

		const one = [user("hi"), ctx("work on #1")];
		assert.equal(pruneStaleInjections(one, "story-context"), one);
	});

	it("does not match a custom message on customType alone", () => {
		// `role` is the discriminant; a non-custom message carrying the same field
		// is not an injection.
		const impostor = { role: "user", customType: "story-context", text: "user said this" };
		const messages = [impostor, ctx("current")];
		assert.deepEqual(pruneStaleInjections(messages, "story-context"), messages);
	});

	it("prunes nothing for a customType it was not asked about", () => {
		const messages = [ctx("one"), ctx("two")];
		assert.equal(pruneStaleInjections(messages, "other-extension"), messages);
	});
});

describe("worktreeDirName", () => {
	it("is a flat directory name, not a path — worktrees are siblings under one root", () => {
		assert.equal(worktreeDirName(story()), "epic-12-add-auth");
		assert.equal(worktreeDirName(story({ id: 3, title: "Fix the / thing" })), "epic-3-fix-the-thing");
	});
});

describe("naming", () => {
	it("slugifies titles", () => {
		assert.equal(slugify("Add OAuth 2.0 support!"), "add-oauth-2-0-support");
		assert.equal(slugify("  spaced  out  "), "spaced-out");
	});

	it("never produces an empty slug, which would make an invalid ref", () => {
		assert.equal(slugify("!!!"), "epic");
		assert.equal(slugify(""), "epic");
	});

	it("trims a trailing dash left by truncation", () => {
		assert.ok(!slugify("a".repeat(30) + " " + "b".repeat(30)).endsWith("-"));
	});

	it("builds branch and backup ref names", () => {
		assert.equal(epicBranchName(story()), "epic/12-add-auth");
		assert.equal(backupRefName(12, "pre-merge"), "refs/pi/backup/12/pre-merge");
	});
});

describe("storyCommitMessage", () => {
	it("puts id, title and resolution in the subject", () => {
		const message = storyCommitMessage(story({ resolution: "completed" }));
		assert.equal(message.subject, "story(#12): Add auth [completed]");
		assert.match(message.body, /Users can sign in/);
	});

	it("includes resolution note and learnings when present", () => {
		const message = storyCommitMessage(
			story({ resolution: "superseded", resolution_note: "folded into #13", learnings: "the API paginates" }),
		);
		assert.match(message.body, /folded into #13/);
		assert.match(message.body, /the API paginates/);
	});

	it("omits the resolution marker while the story is still open", () => {
		assert.equal(storyCommitMessage(story()).subject, "story(#12): Add auth");
	});

	// stories.db has no migrations and is deleted whenever a column is added, so
	// the commit is the copy of the handoff note that survives.
	it("carries the handoff note into the commit body", () => {
		const message = storyCommitMessage(
			story({ resolution: "completed", handoff_notes: "the limiter is keyed by IP, not by token" }),
		);
		assert.match(message.body, /Handoff: the limiter is keyed by IP, not by token/);
	});

	it("omits the handoff line when there is none", () => {
		assert.doesNotMatch(storyCommitMessage(story({ resolution: "completed" })).body, /Handoff:/);
	});
});

describe("chooseUndoStrategy", () => {
	const record = (overrides: Partial<StoryCommit> = {}): StoryCommit => ({
		story_id: 12,
		epic_id: 1,
		start_commit: "aaa",
		commit_sha: "bbb",
		backup_ref: null,
		created_at: 0,
		...overrides,
	});

	it("resets to the start commit while the story is still the tip", () => {
		assert.deepEqual(chooseUndoStrategy(record(), "bbb"), { kind: "reset", to: "aaa" });
	});

	it("reverts once other commits sit on top, so nothing is silently discarded", () => {
		assert.deepEqual(chooseUndoStrategy(record(), "ccc"), { kind: "revert", sha: "bbb" });
	});

	it("does nothing for a story that closed without changes", () => {
		assert.equal(chooseUndoStrategy(record({ commit_sha: null }), "ccc").kind, "none");
	});

	it("does nothing for an unknown story", () => {
		assert.equal(chooseUndoStrategy(null, "ccc").kind, "none");
	});
});

describe("checkStageSize", () => {
	it("allows an ordinary change", () => {
		assert.equal(checkStageSize({ fileCount: 8, totalBytes: 40_000 }).ok, true);
	});

	it("blocks a change that looks like a stray build directory", () => {
		assert.equal(checkStageSize({ fileCount: 5_000, totalBytes: 1_000 }).ok, false);
	});

	it("blocks an oversized change, such as a committed model file", () => {
		assert.equal(checkStageSize({ fileCount: 1, totalBytes: 200 * 1024 * 1024 }).ok, false);
	});
});

describe("isBranchEscapingCommand", () => {
	for (const command of [
		"git switch main",
		"git checkout main",
		"git reset --hard HEAD~1",
		"git branch -D epic/12-add-auth",
		"cd /tmp && git worktree remove /tmp/wt",
	]) {
		it(`blocks: ${command}`, () => assert.equal(isBranchEscapingCommand(command), true));
	}

	for (const command of [
		"git switch -c feature/x",
		"git checkout -- src/app.ts",
		"git status",
		"git commit -m 'reset the counter'",
		"git reset HEAD~1",
	]) {
		it(`allows: ${command}`, () => assert.equal(isBranchEscapingCommand(command), false));
	}
});

describe("findCycle", () => {
	const graph = (edges: Record<number, number[]>) => (id: number) => edges[id] ?? [];

	it("finds nothing in a chain", () => {
		assert.equal(findCycle(1, graph({ 1: [2], 2: [3], 3: [] })), null);
	});

	it("finds nothing in a diamond — a DAG is not a cycle", () => {
		assert.equal(findCycle(1, graph({ 1: [2, 3], 2: [4], 3: [4], 4: [] })), null);
	});

	it("finds a self-loop", () => {
		assert.deepEqual(findCycle(1, graph({ 1: [1] })), [1, 1]);
	});

	it("finds a two-node cycle", () => {
		assert.deepEqual(findCycle(1, graph({ 1: [2], 2: [1] })), [1, 2, 1]);
	});

	it("finds a three-node cycle and reports it in visit order", () => {
		assert.deepEqual(findCycle(1, graph({ 1: [2], 2: [3], 3: [1] })), [1, 2, 3, 1]);
	});

	it("finds a cycle that does not include the start node", () => {
		assert.deepEqual(findCycle(1, graph({ 1: [2], 2: [3], 3: [2] })), [2, 3, 2]);
	});

	it("treats a missing node as a dead end rather than throwing", () => {
		assert.equal(findCycle(1, graph({ 1: [99] })), null);
	});
});

describe("reviewPlan", () => {
	const messages = (findings: ReviewFinding[]) => findings.map((f) => f.message).join("\n");
	const blockers = (findings: ReviewFinding[]) => findings.filter((f) => f.severity === "blocker");

	const good = story({
		id: 1,
		parent_id: 9,
		proposed_changes: "add src/limiter.ts and wire it into the router",
	});

	it("passes a well-formed leaf story with no findings", () => {
		assert.deepEqual(reviewPlan({ story: good, children: [], all: [good] }), []);
	});

	it("blocks an epic — epics are never handed out as work", () => {
		const child = story({ id: 2, parent_id: 1 });
		const findings = reviewPlan({ story: good, children: [child], all: [good, child] });
		assert.equal(blockers(findings).length, 1);
		assert.match(messages(findings), /is an epic with 1 child story/);
	});

	it("blocks a dependency that does not exist", () => {
		const s = story({ ...good, depends_on: [404] });
		const findings = reviewPlan({ story: s, children: [], all: [s] });
		assert.match(messages(blockers(findings)), /#404, which does not exist/);
	});

	it("blocks a dependency cycle — the deadlock nothing else catches", () => {
		const a = story({ id: 1, parent_id: 9, depends_on: [2], proposed_changes: "a".repeat(30) });
		const b = story({ id: 2, parent_id: 9, depends_on: [1], proposed_changes: "b".repeat(30) });
		const findings = reviewPlan({ story: a, children: [], all: [a, b] });
		assert.match(messages(blockers(findings)), /dependency cycle: #1 → #2 → #1/);
	});

	it("blocks a next_id cycle", () => {
		const a = story({ id: 1, parent_id: 9, next_id: 2, proposed_changes: "a".repeat(30) });
		const b = story({ id: 2, parent_id: 9, next_id: 1, proposed_changes: "b".repeat(30) });
		const findings = reviewPlan({ story: a, children: [], all: [a, b] });
		assert.match(messages(blockers(findings)), /next_id cycle: #1 → #2 → #1/);
	});

	it("notes a dependency that can never complete, without blocking", () => {
		const dead = story({ id: 2, status: "cancelled" });
		const s = story({ ...good, depends_on: [2] });
		const findings = reviewPlan({ story: s, children: [], all: [s, dead] });
		assert.equal(blockers(findings).length, 0);
		assert.match(messages(findings), /#2 \(cancelled\)/);
	});

	it("notes proposed_changes too short to act on", () => {
		const s = story({ ...good, proposed_changes: "fix it" });
		assert.match(messages(reviewPlan({ story: s, children: [], all: [s] })), /too short to act on/);
	});

	it("notes a story detached from the tree", () => {
		const s = story({ ...good, parent_id: null });
		assert.match(messages(reviewPlan({ story: s, children: [], all: [s] })), /belongs to no epic/);
	});

	it("notes possible duplicates and excludes the story itself", () => {
		const other = story({ id: 5, title: "Also rate limiting" });
		const findings = reviewPlan({ story: good, children: [], all: [good], similar: [good, other] });
		assert.match(messages(findings), /possible overlap with #5 Also rate limiting/);
		assert.doesNotMatch(messages(findings), /#1 Add auth/);
	});
});

describe("reviewWork", () => {
	const s = story();
	const clean = { story: s, changedFiles: ["src/a.ts"], totalBytes: 100, verify: null };

	it("passes changed files with no verify configured", () => {
		assert.deepEqual(reviewWork(clean), []);
	});

	it("blocks a failing verify and carries its output", () => {
		const findings = reviewWork({ ...clean, verify: { command: "npm test", ok: false, output: "1 failing" } });
		assert.equal(findings[0].severity, "blocker");
		assert.match(findings[0].message, /verify failed \(`npm test`\)/);
		assert.match(findings[0].message, /1 failing/);
	});

	it("passes a verify that succeeds", () => {
		assert.deepEqual(reviewWork({ ...clean, verify: { command: "npm test", ok: true, output: "ok" } }), []);
	});

	it("notes a clean tree without blocking — closing as obsolete is legitimate", () => {
		const findings = reviewWork({ ...clean, changedFiles: [], totalBytes: 0 });
		assert.equal(findings.filter((f) => f.severity === "blocker").length, 0);
		assert.match(findings[0].message, /changed nothing/);
	});

	it("blocks a commit the stage guard would refuse anyway", () => {
		const findings = reviewWork({ ...clean, changedFiles: Array(600).fill("f.ts"), maxFiles: 500 });
		assert.equal(findings[0].severity, "blocker");
		assert.match(findings[0].message, /600 changed files exceeds the limit of 500/);
	});
});

describe("formatFindings", () => {
	it("reads as a clean bill when there is nothing to say", () => {
		assert.equal(formatFindings([]), "No mechanical findings.");
	});

	it("marks blockers distinctly from notes", () => {
		const text = formatFindings([
			{ severity: "blocker", message: "cycle" },
			{ severity: "note", message: "short" },
		]);
		assert.equal(text, "BLOCKER: cycle\nnote: short");
	});
});

describe("unmetDependencies", () => {
	const done = { id: 1, status: "done" } as Story;
	const open = { id: 2, status: "in_progress" } as Story;
	const lookup = (id: number) => ({ 1: done, 2: open })[id as 1 | 2] ?? null;

	it("names only the dependencies that have not closed", () => {
		const s = { depends_on: [1, 2] } as Story;
		assert.deepEqual(unmetDependencies(s, lookup), [2]);
	});

	/** A dependency on a story that no longer exists cannot be satisfied. */
	it("treats a missing dependency as unmet rather than silently satisfied", () => {
		const s = { depends_on: [1, 99] } as Story;
		assert.deepEqual(unmetDependencies(s, lookup), [99]);
	});

	it("is empty when a story depends on nothing", () => {
		assert.deepEqual(unmetDependencies({ depends_on: [] } as unknown as Story, lookup), []);
	});
});

describe("checkCanStart", () => {
	const approved = { verdict: "approved" as const, by: "self", at: 1, findings: "" };
	const base = (overrides: Partial<Story> = {}): Story =>
		({ id: 7, review: { plan: approved }, depends_on: [], ...overrides }) as Story;

	it("allows a leaf story with an approved plan and no unmet dependencies", () => {
		assert.deepEqual(checkCanStart({ story: base(), isEpic: false, openChildren: [], unmet: [] }), { ok: true });
	});

	/** Epics are containers. Starting one would put work on the wrong row. */
	it("refuses an epic and points at the children to start instead", () => {
		const result = checkCanStart({
			story: base(),
			isEpic: true,
			openChildren: [{ id: 8 } as Story, { id: 9 } as Story],
			unmet: [],
		});
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.code, "is an epic");
		assert.match(result.ok === false ? result.message : "", /Start one of its children instead: #8, #9/);
	});

	it("says '(none open)' for an epic whose children have all closed", () => {
		const result = checkCanStart({ story: base(), isEpic: true, openChildren: [], unmet: [] });
		assert.match(result.ok === false ? result.message : "", /children instead: \(none open\)/);
	});

	it("refuses on unmet dependencies and reports which", () => {
		const result = checkCanStart({ story: base(), isEpic: false, openChildren: [], unmet: [3, 4] });
		assert.equal(result.ok === false && result.code, "unmet dependencies");
		assert.match(result.ok === false ? result.message : "", /dependencies not done — #3, #4/);
		assert.deepEqual(result.ok === false ? result.details : null, { unmet: [3, 4] });
	});

	/** The gate is enforced, so the refusal has to say how to open it. */
	it("refuses an unreviewed plan and names the call that reviews it", () => {
		const story = base({ review: {} as Story["review"] });
		const result = checkCanStart({ story, isEpic: false, openChildren: [], unmet: [] });
		assert.equal(result.ok === false && result.code, "plan not approved");
		assert.match(result.ok === false ? result.message : "", /story\{action:"review_plan", story_id:7\}/);
		assert.deepEqual(result.ok === false ? result.details : null, { review: null });
	});

	it("refuses a plan review that requested changes, and quotes the findings", () => {
		const review = { verdict: "changes_requested" as const, by: "gpt/x", at: 1, findings: "split it up" };
		const result = checkCanStart({ story: base({ review: { plan: review } }), isEpic: false, openChildren: [], unmet: [] });
		assert.equal(result.ok === false && result.code, "plan not approved");
		assert.match(result.ok === false ? result.message : "", /requested changes \(by gpt\/x\)/);
		assert.match(result.ok === false ? result.message : "", /split it up/);
	});
});

describe("checkCanClose", () => {
	const approved = { verdict: "approved" as const, by: "self", at: 1, findings: "" };
	const ok = {
		story: { id: 7, review: { work: approved }, depends_on: [] } as unknown as Story,
		isEpic: false,
		openChildren: [],
		unmet: [],
		resolution: "completed" as const,
		handoffNotes: "the auth code is in auth.ts",
	};

	it("allows a reviewed story with a resolution and a handoff note", () => {
		assert.deepEqual(checkCanClose(ok), { ok: true });
	});

	/** An optional field is a skipped field, so both of these are required outright. */
	it("refuses without a resolution and lists the vocabulary", () => {
		const result = checkCanClose({ ...ok, resolution: undefined });
		assert.equal(result.ok === false && result.code, "resolution required");
		assert.match(result.ok === false ? result.message : "", /completed\|superseded\|obsolete\|wontfix\|duplicate/);
	});

	it("refuses without a handoff note", () => {
		const result = checkCanClose({ ...ok, handoffNotes: undefined });
		assert.equal(result.ok === false && result.code, "handoff_notes required");
	});

	it("refuses a handoff note that is only whitespace", () => {
		assert.equal(checkCanClose({ ...ok, handoffNotes: "   \n " }).ok, false);
	});

	it("checks the resolution before the handoff note, so one missing field is reported at a time", () => {
		const result = checkCanClose({ ...ok, resolution: undefined, handoffNotes: undefined });
		assert.equal(result.ok === false && result.code, "resolution required");
	});

	it("refuses unreviewed work and names the call that reviews it", () => {
		const result = checkCanClose({ ...ok, story: { ...ok.story, review: {} } as Story });
		assert.equal(result.ok === false && result.code, "work not approved");
		assert.match(result.ok === false ? result.message : "", /story\{action:"review_work", story_id:7\}/);
	});

	/** An epic carries no commit of its own, so there is no diff to review. */
	it("exempts an epic from the work review", () => {
		const epic = { ...ok, story: { ...ok.story, review: {} } as Story, isEpic: true };
		assert.deepEqual(checkCanClose(epic), { ok: true });
	});

	it("refuses on unmet dependencies", () => {
		const result = checkCanClose({ ...ok, unmet: [3] });
		assert.equal(result.ok === false && result.code, "unmet dependencies");
		assert.match(result.ok === false ? result.message : "", /Cannot mark done: dependencies not done — #3/);
	});

	it("refuses an epic that still has open children, and says they will close it themselves", () => {
		const result = checkCanClose({
			...ok,
			isEpic: true,
			openChildren: [{ id: 8 } as Story],
		});
		assert.equal(result.ok === false && result.code, "open children");
		assert.match(result.ok === false ? result.message : "", /They close it automatically/);
		assert.deepEqual(result.ok === false ? result.details : null, { open: [8] });
	});
});
