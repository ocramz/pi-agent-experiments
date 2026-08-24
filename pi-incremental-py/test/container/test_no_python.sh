#!/usr/bin/env bash
# What the extension does on a machine with no Python.
#
# The one suite here that runs against the DEFAULT image — the pinned one the
# rest of the repo tests against, which has no python3, no pip and no
# /usr/lib/python3* — and the only thing in the repo that can ask this question.
# Every other tier runs somewhere an interpreter happens to exist.
#
# It is not a hypothetical environment. resolvePython falls through to a bare
# "python3" whenever it finds nothing to build a venv from, so this is the exact
# path taken by any user whose PATH has no interpreter. A spawn that fails that
# way emits 'error' and never 'exit': unhandled, that is an uncaught exception
# on an EventEmitter, which ends the whole pi session rather than the tool call.
#
# The probe drives src/kernel.ts directly. Loading extensions/index.ts needs
# pi's own module resolver (typebox lives inside pi's install, not the
# package's), which means running pi, which means a model and an API key — this
# tier is deliberately offline, so that stays in test/tui/live.test.ts.
set -uo pipefail

# No PY_TEST_IMAGE here: the absence of Python is the fixture.
source "$(dirname "$0")/../../../shared/test/container/lib.sh"

PKG="$(cd "$(dirname "$0")/../.." && pwd)"
STAGED="$(stage_pkg "$PKG")" || {
	echo "could not stage the package for the image user" >&2
	exit 1
}
trap 'rm -rf "$STAGED"' EXIT

out="$(RUN_FLAGS="-v $STAGED:/pkg:ro" in_image '
	mkdir -p /tmp/pkg && cp -r /pkg/src /tmp/pkg/ && cp -r /pkg/py /tmp/pkg/ \
		|| { echo "COPY_FAILED"; exit 1; }
	mkdir -p /tmp/proj
	echo "USER_ID=$(id -u)"
	echo "HAS_PYTHON=$(command -v python3 || echo no)"

	cat > /tmp/probe.mjs <<"MJS"
import { Kernel } from "/tmp/pkg/src/kernel.ts";

const kernel = new Kernel(undefined, "/tmp/proj");
const started = Date.now();
const first = await kernel.call({ tool: "inspect" });
// A spawn that failed this way keeps exitCode === null, so the second call is
// the one that catches a kernel handing back the same dead child forever.
const second = await kernel.call({ tool: "add_cell", src: "x = 1" });
console.log("ELAPSED_MS=" + (Date.now() - started));
console.log("FIRST_OK=" + first.ok);
console.log("SECOND_OK=" + second.ok);
console.log("ERROR=" + first.error);
kernel.kill();
MJS

	node /tmp/probe.mjs
	echo "NODE_EXIT=$?"
	# resolvePython bails before mkdir when it has no interpreter to build
	# from, so a directory it could never use should not be left behind.
	echo "LITTER=$(ls -a /tmp/proj | grep -c incremental)"
')"

assert_not_contains "the package is readable by the image user" "COPY_FAILED"  "$out"
assert_contains     "runs as the unprivileged image user"       "USER_ID=65532" "$out"
assert_contains     "the image really has no python"            "HAS_PYTHON=no" "$out"

# The headline: the process survives. Before the 'error' listener existed this
# was an uncaught ENOENT and a non-zero exit, i.e. a dead pi session.
assert_contains "node survives a missing interpreter" "NODE_EXIT=0" "$out"

assert_contains "the call is answered rather than thrown" "FIRST_OK=false"  "$out"
assert_contains "a second call is answered too"           "SECOND_OK=false" "$out"

# The tool result is all the agent ever sees, so the message has to carry both
# what was tried and the way out.
assert_contains "the error names the interpreter it tried" "python not found: python3" "$out"
assert_contains "the error points at a fix"                "/py-python"                "$out"
assert_contains "the error mentions the override"          "PI_PYTHON"                 "$out"

# 'exit' never fires for an ENOENT spawn, so without the listener the round
# trip would sit on its 120s timeout instead of failing fast.
elapsed="$(printf '%s\n' "$out" | sed -n 's/^ELAPSED_MS=//p')"
if [ "${elapsed:-999999}" -lt 5000 ] 2>/dev/null; then
	ok "it fails fast rather than waiting out the timeout (${elapsed}ms)"
else
	fail "it fails fast rather than waiting out the timeout" \
		"expected under 5000ms" "actual: ${elapsed:-none reported}ms"
fi

assert_contains "no unusable .incremental directory is left behind" "LITTER=0" "$out"

summary
