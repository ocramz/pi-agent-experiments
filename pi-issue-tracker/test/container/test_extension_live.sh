#!/usr/bin/env bash
# The only tier that reaches extensions/index.ts at all.
#
# Everything in that file hangs off a pi runtime — registerTool, the turn_end
# checkpoint, the tool_call branch guard — so none of it can be exercised without
# starting pi and letting it talk to a model. That makes this suite slow,
# non-deterministic and not free, which is why it runs last. It is still the only
# evidence that the extension does anything at all inside the image.
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
source "$(dirname "$0")/lib.sh"

# Per pi invocation. Generous: a healthy run is well under a minute, and the
# point is to catch a wedge, not to police latency.
PI_TIMEOUT="${PI_TIMEOUT:-240}"

PKG="$(cd "$(dirname "$0")/../.." && pwd)"
STAGED="$(stage_pkg "$PKG")" || { echo "could not stage the package for the image user" >&2; exit 1; }
trap 'rm -rf "$STAGED"' EXIT

: "${PI_PROVIDER:?PI_PROVIDER must be set}"
: "${PI_MODEL:?PI_MODEL must be set}"

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

summary
