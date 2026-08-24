#!/usr/bin/env bash
# The TypeScript unit suite, in the image userland.
#
# The cases stub fetch, so nothing here needs the network — the point of
# running them in the image is the userland, not the assertions: an
# unprivileged uid on a filesystem where only /tmp is writable, and no
# node_modules, proving the extension loads against nothing but what pi
# supplies at runtime.
#
# `node --test` is spelled out rather than going through `npm test`: npm is
# not on PATH in the image, so package.json cannot be the single source of
# truth here. test/tui/ stays out — it needs a pty and its own node_modules.
set -uo pipefail

source "$(dirname "$0")/../../../shared/test/container/lib.sh"

PKG="$(cd "$(dirname "$0")/../.." && pwd)"
STAGED="$(stage_pkg "$PKG")" || {
	echo "could not stage the package for the image user" >&2
	exit 1
}
trap 'rm -rf "$STAGED"' EXIT

out="$(RUN_FLAGS="-v $STAGED:/pkg:ro" in_image '
	cp -r /pkg /tmp/pkg || { echo "COPY_FAILED"; exit 1; }
	cd /tmp/pkg
	echo "USER_ID=$(id -u)"
	echo "HOME_IS=$HOME"
	node --test "test/*.test.ts" 2>&1 | tail -25
')"

assert_not_contains "the package is readable by the image user" "COPY_FAILED"  "$out"
assert_contains     "runs as the unprivileged image user"       "USER_ID=65532" "$out"
assert_contains     "HOME is redirected to the writable path"   "HOME_IS=/tmp"  "$out"

# A floor, not just "fail 0": a suite that runs nothing reports no failures.
passed="$(printf '%s\n' "$out" | sed -n 's/^.*pass \([0-9][0-9]*\)$/\1/p')"
if [ "${passed:-0}" -ge 10 ] 2>/dev/null; then
	ok "the suite actually ran ($passed tests)"
else
	fail "the suite actually ran" "expected at least 10 passing tests" \
		"actual: ${passed:-none reported}"
fi

assert_contains     "no test failures"      "fail 0"      "$out"
assert_not_contains "no test was cancelled" "cancelled 1" "$out"

summary
