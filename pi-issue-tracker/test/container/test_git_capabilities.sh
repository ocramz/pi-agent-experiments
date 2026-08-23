#!/usr/bin/env bash
# The gate on everything else.
#
# The image's git is built with C builtins only and without perl, to save ~35 MB.
# Every git feature this extension depends on is therefore an assumption until
# proven here. If `stash create` is missing, /undo-turn has to be rebuilt around
# `commit-tree`; if `worktree` is missing, worktree mode cannot exist at all.
# Much cheaper to learn on day one than after the feature is written.
#
# Note for edits: userland is busybox — no `grep -P`, no GNU-only find predicates.
# The snippet below is passed through `bash -c`, so anything the outer shell would
# choke on has to be quoted — an unquoted `%(refname)` aborts the whole probe and
# takes every assertion after it down with it.
source "$(dirname "$0")/lib.sh"

out="$(in_image '
	export GIT_CONFIG_GLOBAL=/tmp/gitconfig GIT_CONFIG_SYSTEM=/dev/null HOME=/tmp
	git config --global user.email t@example.invalid
	git config --global user.name Test

	echo "VERSION=$(git --version)"

	R=/tmp/r; rm -rf $R /tmp/wt; mkdir -p $R; cd $R
	git init -q .
	echo one > a.txt; git add -A; git commit -qm one
	git switch -q -c feat/test
	echo two > b.txt; git add -A; git commit -qm two

	# The database-anchoring fix: a linked worktree must resolve to the MAIN
	# working tree, or the extension opens an empty stories.db and loses the epic.
	git rev-parse --path-format=absolute --git-common-dir >/dev/null 2>&1 \
		&& echo "PATH_FORMAT=ok" || echo "PATH_FORMAT=missing"

	# /undo-turn: stash create must produce a commit WITHOUT disturbing the tree.
	echo dirty >> a.txt
	S=$(git stash create 2>/dev/null)
	[ -n "$S" ] && echo "STASH_CREATE=ok" || echo "STASH_CREATE=missing"
	echo "STASH_LEAVES_TREE_DIRTY=$(git status --porcelain | wc -l | tr -d " ")"
	git checkout -q -- a.txt

	# Backup refs — the rule that nothing becomes unreachable.
	git update-ref refs/pi/backup/1/pre-merge HEAD && echo "UPDATE_REF=ok"
	echo "FOR_EACH_REF=$(git for-each-ref --format="%(refname)" refs/pi/backup)"

	# Worktree mode.
	git worktree add -q -b epic/1-x /tmp/wt feat/test 2>/dev/null && echo "WORKTREE_ADD=ok"
	git worktree list --porcelain >/dev/null 2>&1 && echo "WORKTREE_LIST=ok"
	echo "WORKTREE_COMMON_DIR=$(cd /tmp/wt && git rev-parse --path-format=absolute --git-common-dir)"

	# Step 2 of the merge: fast-forward only, so it cannot fail partway.
	cd /tmp/wt; echo three > c.txt; git add -A; git commit -qm three
	cd $R
	git merge --ff-only epic/1-x >/dev/null 2>&1 && echo "MERGE_FF_ONLY=ok"

	# /undo-story off the tip.
	git revert --no-commit HEAD >/dev/null 2>&1 && echo "REVERT_NO_COMMIT=ok"
	git revert --quit 2>/dev/null; git reset -q --hard

	git worktree remove /tmp/wt && echo "WORKTREE_REMOVE=ok"
')"

assert_contains "git is present"                        "VERSION=git version"        "$out"
assert_contains "rev-parse --path-format=absolute"      "PATH_FORMAT=ok"             "$out"
assert_contains "stash create (backs /undo-turn)"       "STASH_CREATE=ok"            "$out"
assert_eq       "stash create leaves the tree untouched" "STASH_LEAVES_TREE_DIRTY=1" \
	"$(printf '%s\n' "$out" | grep '^STASH_LEAVES_TREE_DIRTY=')"
assert_contains "update-ref (backup refs)"              "UPDATE_REF=ok"              "$out"
assert_contains "for-each-ref reads them back"          "refs/pi/backup/1/pre-merge" "$out"
assert_contains "worktree add"                          "WORKTREE_ADD=ok"            "$out"
assert_contains "worktree list --porcelain"             "WORKTREE_LIST=ok"           "$out"
assert_contains "a worktree resolves to the MAIN repo"  "WORKTREE_COMMON_DIR=/tmp/r/.git" "$out"
assert_contains "merge --ff-only"                       "MERGE_FF_ONLY=ok"           "$out"
assert_contains "revert --no-commit"                    "REVERT_NO_COMMIT=ok"        "$out"
assert_contains "worktree remove"                       "WORKTREE_REMOVE=ok"         "$out"

summary
