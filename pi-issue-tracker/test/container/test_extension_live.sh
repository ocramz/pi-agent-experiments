#!/usr/bin/env bash
# The only tier that reaches extensions/ at all.
#
# Registration hangs off a pi runtime — registerTool, the turn_end checkpoint,
# the tool_call branch guard — so none of it can be exercised without starting pi
# and letting it talk to a model. That makes this suite slow, non-deterministic
# and not free, which is why it runs last. It is still the only evidence that the
# extension does anything at all inside the image.
#
# What each registration *does* now lives in src/ and is covered for free by
# `npm test`, so what this tier proves is the wiring: that pi loads the file, that
# the tool and its hooks are reachable, and that a real model can drive them.
#
# Assertions deliberately target durable state — rows in stories.db, refs, the
# contents of .git/info/exclude — rather than assistant prose, which varies run
# to run.
#
# Needs OPENROUTER_API_KEY, PI_PROVIDER and PI_MODEL in the environment; run.sh
# checks for the key and forwards all three into the container.
#
# Every pi call is wrapped in `timeout`, because a model with a bash tool has no
# natural stopping point. One run here blocked for twenty minutes on
# `grep -r "strand its work" /` — the model, having been blocked by the branch
# guard, went looking through the whole filesystem for the source of the message.
# An unbounded live test is one curious model away from wedging CI, so a run that
# overshoots its budget fails instead of hanging.
source "$(dirname "$0")/../../../shared/test/container/lib.sh"

# Per pi invocation. Generous: a healthy run is well under a minute, and the
# point is to catch a wedge, not to police latency.
PI_TIMEOUT="${PI_TIMEOUT:-240}"

# Block 3 drives a five-call sequence rather than a single tool call, so it needs
# proportionally longer. Still bounded, which is the invariant that matters — an
# unbounded live test is one curious model away from wedging CI.
CYCLE_TIMEOUT="${CYCLE_TIMEOUT:-$((PI_TIMEOUT * 2))}"

PKG="$(cd "$(dirname "$0")/../.." && pwd)"
STAGED="$(stage_pkg "$PKG")" || { echo "could not stage the package for the image user" >&2; exit 1; }
trap 'rm -rf "$STAGED"' EXIT

: "${PI_PROVIDER:?PI_PROVIDER must be set}"
: "${PI_MODEL:?PI_MODEL must be set}"

# Block 4 needs a reviewer. shared/versions.sh defaults these to the working
# model, so "unset" here means the caller bypassed it rather than that no
# reviewer was chosen — fall back the same way instead of failing.
PI_REVIEW_PROVIDER="${PI_REVIEW_PROVIDER:-$PI_PROVIDER}"
PI_REVIEW_MODEL="${PI_REVIEW_MODEL:-$PI_MODEL}"

# ── 1. The story tool, end to end ────────────────────────────────────
# Extension load, session_start, resolvePaths off the git common dir, openDb,
# ensureDatabaseIgnored, registerTool, and the tool's create path — one live run
# covers the whole chain, and the database is the proof.
tool_out="$(RUN_FLAGS="-v $STAGED:/pkg:ro -e PI_TIMEOUT=$PI_TIMEOUT" in_image '
	cp -r /pkg /tmp/pkg || { echo "COPY_FAILED"; exit 1; }
	export GIT_CONFIG_GLOBAL=/tmp/gitconfig GIT_CONFIG_SYSTEM=/dev/null
	git config --global user.email t@example.invalid
	git config --global user.name Test

	mkdir -p /tmp/repo && cd /tmp/repo
	git init -q .
	echo hi > a.txt && git add -A && git commit -qm one
	echo "USER_ID=$(id -u)"

	timeout "$PI_TIMEOUT" pi --print --no-session --provider "$PI_PROVIDER" --model "$PI_MODEL" \
		-e /tmp/pkg/extensions/index.ts \
		"Use the story tool to create one story. Set title to exactly SMOKE and sub_goal to exactly proving-the-tool-works. Then stop." \
		> /tmp/pi1.log 2>&1
	case $? in 124 | 137 | 143) echo "PI_TIMED_OUT=yes" ;; esac
	tail -3 /tmp/pi1.log

	grep -q stories.db .git/info/exclude && echo "EXCLUDED=ok" || echo "EXCLUDED=missing"

	cat > /tmp/rows.mjs <<"MJS"
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/tmp/repo/.pi/stories.db");
const rows = db.prepare("select title, status from stories").all();
console.log("ROWCOUNT=" + rows.length);
console.log("ROWS=" + JSON.stringify(rows));
MJS
	node /tmp/rows.mjs 2>&1 | grep -E "^(ROWS|ROWCOUNT)="
')"

assert_not_contains "the package is readable by the image user" "COPY_FAILED"      "$tool_out"
assert_not_contains "pi finished inside its time budget"        "PI_TIMED_OUT=yes" "$tool_out"
assert_contains     "runs as the unprivileged image user"       "USER_ID=65532"    "$tool_out"
assert_contains     "session_start excludes the database"       "EXCLUDED=ok"      "$tool_out"
assert_contains     "the model reached the story tool"          '"title":"SMOKE"'  "$tool_out"
# Exactly one row: the tool ran once and wrote once. The *status* is deliberately
# not asserted — it is a tool parameter, so the model picks it, and pinning it
# would make this suite fail on a reasonable choice.
assert_contains     "the tool wrote exactly one story"          "ROWCOUNT=1"       "$tool_out"

# ── 2. The two hooks, on a seeded epic ───────────────────────────────
# The branch guard and the checkpoint both need an active epic, which only
# /start-epic creates — and slash commands are dispatched by the TUI alone, so
# the epic is seeded by calling startEpic from src/ directly. One live turn then
# exercises both: the guard blocks the branch switch, and turn_end checkpoints
# the dirty tree on the way out.
hook_out="$(RUN_FLAGS="-v $STAGED:/pkg:ro -e PI_TIMEOUT=$PI_TIMEOUT" in_image '
	cp -r /pkg /tmp/pkg2 || { echo "COPY_FAILED"; exit 1; }
	export GIT_CONFIG_GLOBAL=/tmp/gitconfig2 GIT_CONFIG_SYSTEM=/dev/null
	git config --global user.email t@example.invalid
	git config --global user.name Test

	mkdir -p /tmp/repo2 && cd /tmp/repo2
	git init -q -b main .
	echo hi > a.txt && git add -A && git commit -qm one

	cat > /tmp/seed.mjs <<"MJS"
import { resolvePaths } from "/tmp/pkg2/src/config.ts";
import { createStory, openDb } from "/tmp/pkg2/src/database.ts";
import { createLocalGitRunner, createLocalShellRunner } from "/tmp/pkg2/src/git.ts";
import { keywordStrategy } from "/tmp/pkg2/src/related.ts";
import { startEpic } from "/tmp/pkg2/src/epic.ts";

const dir = "/tmp/repo2";
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/tmp/gitconfig2", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = createLocalGitRunner({ cwd: dir, env });
const shell = createLocalShellRunner({ cwd: dir, env });
const paths = await resolvePaths({ cwd: dir, git, overrides: { repoRoot: dir }, env: {} });
const db = openDb(paths.dbPath);
const ctx = { paths, db, git, shell, related: keywordStrategy, now: () => Date.now(), notify: () => {} };
const story = createStory(db, {
	title: "Guarded epic", sub_goal: "hold the branch", proposed_changes: "",
	status: "draft", priority: 1, parent_id: null, next_id: null, depends_on: [],
});
const outcome = await startEpic(ctx, { story });
console.log("SEED=" + (outcome.ok ? "ok" : "failed: " + outcome.note));
db.close();
MJS
	node /tmp/seed.mjs 2>&1 | grep "^SEED="
	echo "EPIC_BRANCH=$(git branch --show-current)"

	# turn_end only checkpoints a dirty tree — a clean one is nothing to save.
	echo dirty >> a.txt

	# --tools bash removes the choice of doing something else, and --mode json puts
	# the blocked tool result in the stream: asserting on the guard reason there is
	# deterministic, where asserting on the assistant summarising it is not.
	#
	# The command is `worktree remove` rather than the obvious `git switch main`
	# for a reason worth keeping. before_agent_start injects "do not switch
	# branches, reset --hard, or delete branches" into the context, so a model
	# asked to switch branches reads that, refuses, and the guard under test never
	# fires — restating that the block is expected does not help, it just reads as
	# a trick. `git worktree remove` is in isBranchEscapingCommand but not in that
	# warning, so the model runs it as ordinary cleanup and the guard does its job.
	git worktree add -q -b tmp/stale /tmp/wt HEAD 2>/dev/null
	timeout "$PI_TIMEOUT" pi --print --mode json --tools bash --no-session \
		--provider "$PI_PROVIDER" --model "$PI_MODEL" \
		-e /tmp/pkg2/extensions/index.ts \
		"Clean up the stale worktree by running this command: git worktree remove /tmp/wt. Run that one command, report the result, and then stop — do not investigate further." \
		> /tmp/pi2.log 2>&1
	case $? in 124 | 137 | 143) echo "PI_TIMED_OUT=yes" ;; esac
	guard="$(cat /tmp/pi2.log)"
	case "$guard" in
	*"Epic #1 is active"*) echo "GUARD=blocked" ;;
	*) echo "GUARD=not-triggered"; printf "%s\n" "$guard" | tail -3 ;;
	esac
	case "$guard" in
	*story-context*) echo "CONTEXT=injected" ;;
	*) echo "CONTEXT=missing" ;;
	esac

	echo "BRANCH_AFTER=$(git branch --show-current)"
	echo "CHECKPOINTS=$(git for-each-ref --format="%(refname)" refs/pi/checkpoint | wc -l | tr -d " ")"
')"

assert_not_contains "pi finished inside its time budget" "PI_TIMED_OUT=yes"                 "$hook_out"
assert_contains "the epic seeds onto its own branch"   "SEED=ok"                            "$hook_out"
assert_contains "before_agent_start injects the epic"  "CONTEXT=injected"                   "$hook_out"
assert_contains "the branch guard blocks the escape"   "GUARD=blocked"                      "$hook_out"
assert_contains "the epic branch is still checked out" "BRANCH_AFTER=epic/1-guarded-epic"   "$hook_out"

# A count, not a name: the ref is timestamped, and one turn is one checkpoint.
checkpoints="$(printf '%s\n' "$hook_out" | sed -n 's/^CHECKPOINTS=\([0-9][0-9]*\)$/\1/p')"
if [ "${checkpoints:-0}" -ge 1 ] 2>/dev/null; then
	ok "turn_end checkpointed the dirty tree ($checkpoints ref)"
else
	fail "turn_end checkpointed the dirty tree" "expected at least one refs/pi/checkpoint ref" \
		"actual: ${checkpoints:-none reported}"
fi

# ── 3. The autonomous cycle, self-reviewed ───────────────────────────
# The whole point of the review gates: an agent creating, reviewing, starting,
# doing and closing work without a human in the loop. Nothing below this tier can
# show that, because the gates are enforced in the tool and only a model calls a
# tool.
#
# Self-review is the shipped default — no reviewer configured — so this is the
# path that must never regress. The prompt is an explicit recipe for the same
# reason every prompt in this file is: the gates refuse in a specific order, and
# a model left to improvise hits the first refusal and gives up.
cycle_out="$(RUN_FLAGS="-v $STAGED:/pkg:ro -e PI_TIMEOUT=$PI_TIMEOUT -e CYCLE_TIMEOUT=$CYCLE_TIMEOUT" in_image '
	cp -r /pkg /tmp/pkg3 || { echo "COPY_FAILED"; exit 1; }
	export GIT_CONFIG_GLOBAL=/tmp/gitconfig3 GIT_CONFIG_SYSTEM=/dev/null
	git config --global user.email t@example.invalid
	git config --global user.name Test

	mkdir -p /tmp/repo3 && cd /tmp/repo3
	git init -q -b main .
	echo hi > a.txt && git add -A && git commit -qm one
	git switch -q -c feat/work

	# The epic has to exist before any of this: /start-epic is a command, the
	# model cannot run one, and a story with no epic has no working tree to
	# review and produces no commit. Seeded from src/ exactly as block 2 does.
	cat > /tmp/seed3.mjs <<"MJS"
import { resolvePaths } from "/tmp/pkg3/src/config.ts";
import { createStory, openDb } from "/tmp/pkg3/src/database.ts";
import { createLocalGitRunner, createLocalShellRunner } from "/tmp/pkg3/src/git.ts";
import { keywordStrategy } from "/tmp/pkg3/src/related.ts";
import { startEpic } from "/tmp/pkg3/src/epic.ts";

const dir = "/tmp/repo3";
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/tmp/gitconfig3", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = createLocalGitRunner({ cwd: dir, env });
const shell = createLocalShellRunner({ cwd: dir, env });
const paths = await resolvePaths({ cwd: dir, git, overrides: { repoRoot: dir }, env: {} });
const db = openDb(paths.dbPath);
const ctx = { paths, db, git, shell, related: keywordStrategy, now: () => Date.now(), notify: () => {} };
const epic = createStory(db, {
	title: "Widget epic", sub_goal: "ship the widget", proposed_changes: "",
	status: "draft", priority: 1, parent_id: null, next_id: null, depends_on: [],
});
const child = createStory(db, {
	title: "Add the greeting file", sub_goal: "a greeting file exists at greeting.txt",
	proposed_changes: "create greeting.txt containing the word hello",
	status: "ready", priority: 2, parent_id: epic.id, next_id: null, depends_on: [],
});
// #3 is never reviewed. It exists so the bypass probe below has an unreviewed
// story to attack without disturbing the one the cycle is working.
const untouched = createStory(db, {
	title: "Untouched story", sub_goal: "never reviewed", proposed_changes: "nothing",
	status: "ready", priority: 3, parent_id: epic.id, next_id: null, depends_on: [],
});
const outcome = await startEpic(ctx, { story: epic });
console.log("SEED=" + (outcome.ok ? "ok" : "failed: " + outcome.note));
console.log("CHILD_ID=" + child.id);
console.log("UNTOUCHED_ID=" + untouched.id);
db.close();
MJS
	node /tmp/seed3.mjs 2>&1 | grep -E "^(SEED|CHILD_ID|UNTOUCHED_ID)="

	# The story"s work is done here rather than by the model, exactly as block 2
	# dirties the tree itself. What is under test is the tracker cycle and the
	# commit that closing produces — not whether a cheap model remembers to write
	# a file. Leaving it to the model made this assert on compliance instead: a
	# skipped write leaves a clean tree, commitStory correctly declines to commit
	# nothing, and the handoff assertion failed for a reason it was not about.
	echo hello > greeting.txt

	# Four calls, not seven. The no-verdict "report" call on each gate is a
	# convenience, and doubling the round-trips is what pushed an earlier version
	# of this block past its budget — that path is covered free by group J in
	# test/tui/ and by test/review.test.ts.
	timeout "$CYCLE_TIMEOUT" pi --print --no-session \
		--provider "$PI_PROVIDER" --model "$PI_MODEL" \
		-e /tmp/pkg3/extensions/index.ts \
		"greeting.txt has already been written. Close out story #2 by making exactly these four tool calls in this order, and then stop.
1. story tool: action review_plan, story_id 2, verdict approved, findings \"the scope is one commit of work\".
2. story tool: action mark_in_progress, story_id 2.
3. story tool: action review_work, story_id 2, verdict approved, findings \"greeting.txt was created as planned\".
4. story tool: action mark_done, story_id 2, resolution completed, handoff_notes \"the greeting lives in greeting.txt at the repository root and is a single lowercase word\".
Then stop. Do not investigate anything else and do not run any other command." \
		> /tmp/pi3.log 2>&1
	case $? in 124 | 137 | 143) echo "PI_TIMED_OUT=yes" ;; esac

	cat > /tmp/rows3.mjs <<"MJS"
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/tmp/repo3/.pi/stories.db");
const row = db.prepare("select status, review, handoff_notes from stories where id = 2").get();
const review = JSON.parse(row?.review ?? "{}");
console.log("STATUS=" + row?.status);
console.log("PLAN_VERDICT=" + (review.plan?.verdict ?? "none"));
console.log("PLAN_BY=" + (review.plan?.by ?? "none"));
console.log("WORK_VERDICT=" + (review.work?.verdict ?? "none"));
console.log("HANDOFF_LEN=" + String(row?.handoff_notes ?? "").trim().length);
MJS
	node /tmp/rows3.mjs 2>&1 | grep -E "^(STATUS|PLAN_VERDICT|PLAN_BY|WORK_VERDICT|HANDOFF_LEN)="

	git log -1 --pretty=%B | grep -q "^Handoff:" && echo "COMMIT_HANDOFF=ok" || echo "COMMIT_HANDOFF=missing"
	echo "COMMIT_SUBJECT=$(git log -1 --pretty=%s)"

	# The gates are only worth having if they cannot be walked around. `update`
	# writes any status with no checks, so it used to be a one-call bypass of both
	# — an earlier run of this very block found that by taking it.
	#
	# --mode json for the same reason block 2 uses it: the refusal is a tool
	# result, and asserting on the assistant paraphrasing it is not deterministic.
	timeout "$PI_TIMEOUT" pi --print --mode json --no-session \
		--provider "$PI_PROVIDER" --model "$PI_MODEL" \
		-e /tmp/pkg3/extensions/index.ts \
		"Call the story tool exactly once, with action update, story_id 3, and status in_progress. Then stop. Do not call the story tool again with any other action, and do not try to work around a refusal — a refusal is the expected result and reporting it is all that is wanted." \
		> /tmp/pi3b.log 2>&1
	case $? in 124 | 137 | 143) echo "PI_TIMED_OUT=yes" ;; esac
	grep -q "use mark_in_progress instead" /tmp/pi3b.log && echo "UPDATE_BYPASS=refused" || echo "UPDATE_BYPASS=allowed"

	cat > /tmp/rows3b.mjs <<"MJS"
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/tmp/repo3/.pi/stories.db");
const row = db.prepare("select status from stories where id = 3").get();
console.log("BYPASS_STATUS=" + (row?.status ?? "none"));
MJS
	node /tmp/rows3b.mjs 2>&1 | grep "^BYPASS_STATUS="
')"

assert_not_contains "pi finished inside its time budget"   "PI_TIMED_OUT=yes"       "$cycle_out"
assert_contains "the epic and its child seed"              "SEED=ok"                "$cycle_out"
assert_contains "the plan gate was reviewed and approved"  "PLAN_VERDICT=approved"  "$cycle_out"
assert_contains "self-review is attributed as self"        "PLAN_BY=self"           "$cycle_out"
assert_contains "the work gate was reviewed and approved"  "WORK_VERDICT=approved"  "$cycle_out"
assert_contains "the story closed"                         "STATUS=done"            "$cycle_out"
# The commit is the copy of the handoff note that survives stories.db being
# deleted, which is what makes the no-migration cost tolerable.
assert_contains "the handoff note reached the commit"      "COMMIT_HANDOFF=ok"      "$cycle_out"

# A gate that can be walked around is not a gate. Both halves are asserted: the
# refusal reached the model, and the status did not move regardless.
assert_contains "update cannot bypass the plan gate"       "UPDATE_BYPASS=refused"  "$cycle_out"
assert_contains "the bypassed story never started"         "BYPASS_STATUS=ready"    "$cycle_out"

# A length, not a string: the note is prose the model writes, so only its
# presence is assertable. Anything shorter than this is not a handoff note.
handoff="$(printf '%s\n' "$cycle_out" | sed -n 's/^HANDOFF_LEN=\([0-9][0-9]*\)$/\1/p')"
if [ "${handoff:-0}" -ge 20 ] 2>/dev/null; then
	ok "mark_done recorded a handoff note ($handoff chars)"
else
	fail "mark_done recorded a handoff note" "expected at least 20 characters" "actual: ${handoff:-none reported}"
fi

# ── 4. The independent reviewer ──────────────────────────────────────
# Everything the reviewer *decides* is covered free in test/review.test.ts against
# a stub. What only a live run can show is that a second model is reached at all:
# that resolveReviewer finds it, that ctx.modelRegistry.complete is callable from
# inside a tool, and that the verdict is attributed to that model rather than to
# "self". PI_REVIEW_MODEL defaults to PI_MODEL, so this costs one extra call and
# no second pin — see shared/versions.env.
#
# The prompt asks for a verdict on purpose. With a reviewer configured the tool
# must refuse it, and that refusal is the strict-independence rule doing its job
# where a model can actually run into it.
review_out="$(RUN_FLAGS="-v $STAGED:/pkg:ro -e PI_TIMEOUT=$PI_TIMEOUT -e PI_TRACKER_REVIEW_PROVIDER=$PI_REVIEW_PROVIDER -e PI_TRACKER_REVIEW_MODEL=$PI_REVIEW_MODEL" in_image '
	cp -r /pkg /tmp/pkg4 || { echo "COPY_FAILED"; exit 1; }
	export GIT_CONFIG_GLOBAL=/tmp/gitconfig4 GIT_CONFIG_SYSTEM=/dev/null
	git config --global user.email t@example.invalid
	git config --global user.name Test

	mkdir -p /tmp/repo4 && cd /tmp/repo4
	git init -q -b main .
	echo hi > a.txt && git add -A && git commit -qm one
	git switch -q -c feat/work
	echo "REVIEWER=$PI_TRACKER_REVIEW_MODEL"

	# No epic here: this block is only about who decides the plan verdict, and a
	# plan review needs no working tree.
	cat > /tmp/seed4.mjs <<"MJS"
import { createStory, openDb } from "/tmp/pkg4/src/database.ts";

const db = openDb("/tmp/repo4/.pi/stories.db");
createStory(db, {
	title: "Add the greeting file", sub_goal: "a greeting file exists at greeting.txt",
	proposed_changes: "create greeting.txt containing the word hello",
	status: "ready", priority: 1, parent_id: null, next_id: null, depends_on: [],
});
console.log("SEED=ok");
db.close();
MJS
	node /tmp/seed4.mjs 2>&1 | grep "^SEED="

	# --mode json: the refusal is a tool result, not assistant prose.
	timeout "$PI_TIMEOUT" pi --print --mode json --no-session \
		--provider "$PI_PROVIDER" --model "$PI_MODEL" \
		-e /tmp/pkg4/extensions/index.ts \
		"Call the story tool with action review_plan, story_id 1, and verdict approved. If it refuses, call it once more with action review_plan and story_id 1 and no verdict. Then stop — do not do anything else." \
		> /tmp/pi4.log 2>&1
	case $? in 124 | 137 | 143) echo "PI_TIMED_OUT=yes" ;; esac
	grep -q "not yours to set" /tmp/pi4.log && echo "SELF_VERDICT=refused" || echo "SELF_VERDICT=accepted"

	cat > /tmp/rows4.mjs <<"MJS"
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/tmp/repo4/.pi/stories.db");
const row = db.prepare("select review from stories where id = 1").get();
const review = JSON.parse(row?.review ?? "{}");
console.log("PLAN_BY=" + (review.plan?.by ?? "none"));
console.log("PLAN_RECORDED=" + (review.plan ? "yes" : "no"));
MJS
	node /tmp/rows4.mjs 2>&1 | grep -E "^(PLAN_BY|PLAN_RECORDED)="
')"

assert_not_contains "pi finished inside its time budget" "PI_TIMED_OUT=yes"      "$review_out"
assert_contains "the story seeds"                        "SEED=ok"               "$review_out"
# The strict-independence rule, reached by a real model rather than a stub.
assert_contains "the agent's own verdict is refused"     "SELF_VERDICT=refused"  "$review_out"
assert_contains "the reviewer recorded a verdict"        "PLAN_RECORDED=yes"     "$review_out"
# The assertion this whole block exists for: a second model was actually called,
# so the verdict is attributed to it and not to the agent that asked.
assert_not_contains "the verdict is not self-attributed" "PLAN_BY=self"          "$review_out"
assert_contains "the verdict names the reviewer model"   "PLAN_BY=$PI_REVIEW_PROVIDER/$PI_REVIEW_MODEL" "$review_out"

summary
