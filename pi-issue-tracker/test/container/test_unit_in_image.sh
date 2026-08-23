#!/usr/bin/env bash
# Re-run the host unit suite inside the image.
#
# Nearly free — it reuses test/ wholesale — and it is the only thing that proves
# the logic survives the image's actual userland: perl-less git, busybox coreutils,
# and an unprivileged user who can only write under /tmp.
#
# The package is mounted read-only and copied to /tmp first, because the tests
# create repositories and databases.
#
# The glob is `test/*.test.ts`, kept in step with package.json's `test` script and
# for the same reason: test/tui/ is the interactive tier and needs pi on PATH, a
# pty, and its own node_modules. None of those exist in this image, and npm is not
# here either to make the script the single source of truth.
#
# Two of the assertions below exist because this suite once reported "3 passed"
# while running no tests at all: every source file was unreadable to the image
# user, the copy failed silently, and `node --test` over an empty tree still
# reports "fail 0". A copy error is now fatal, and the pass count has a floor.
# stage_pkg is what stops it happening in the first place.
source "$(dirname "$0")/lib.sh"

PKG="$(cd "$(dirname "$0")/../.." && pwd)"
STAGED="$(stage_pkg "$PKG")" || { echo "could not stage the package for the image user" >&2; exit 1; }
trap 'rm -rf "$STAGED"' EXIT

out="$(RUN_FLAGS="-v $STAGED:/pkg:ro" in_image '
	cp -r /pkg /tmp/pkg || { echo "COPY_FAILED"; exit 1; }
	cd /tmp/pkg
	echo "USER_ID=$(id -u)"
	node --test "test/*.test.ts" 2>&1 | tail -20
')"

assert_not_contains "the package is readable by the image user" "COPY_FAILED"  "$out"
assert_contains     "runs as the unprivileged image user"       "USER_ID=65532" "$out"

# A floor, not an exact count: the suite grows, but it must never be empty.
# The reporter marks the line with U+2139 or with "#" depending on the stream, so
# match on the word rather than the prefix.
passed="$(printf '%s\n' "$out" | sed -n 's/^.*pass \([0-9][0-9]*\)$/\1/p')"
if [ "${passed:-0}" -ge 50 ] 2>/dev/null; then
	ok "the suite actually ran ($passed tests)"
else
	fail "the suite actually ran" "expected at least 50 passing tests" "actual: ${passed:-none reported}"
fi

assert_contains     "no test failures"      "fail 0"      "$out"
assert_not_contains "no test was cancelled" "cancelled 1" "$out"

summary
