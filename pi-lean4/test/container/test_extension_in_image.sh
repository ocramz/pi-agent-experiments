#!/usr/bin/env bash
# The extension, loaded by the image's own pi, on a machine with no Lean.
#
# This is the only place the entry point meets the distroless userland: pi
# resolves typebox, pi-ai and pi-coding-agent from its own install, so a
# package import that only worked through a host node_modules would fail here.
# The scripted faux model (test/faux/faux-model.ts) stands in for a provider,
# so nothing needs a key or the network (--offline).
#
# Asserted: pi exits 0; the model is told the tools exist; a Lean tool call is
# answered with an error that names the fix — not a crash, not a hang; and
# /lean status works.
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
	mkdir -p /tmp/proj/.faux && cd /tmp/proj
	printf "leanprover/lean4:v4.34.1\n" > lean-toolchain
	printf "name = \"fixture\"\n" > lakefile.toml
	printf "theorem a : True := trivial\n" > A.lean
	cat > .faux/script.json <<"JSON"
[{"tool": "lean_diagnostics", "args": {"path": "A.lean"}}, {"text": "SCRIPT-COMPLETE"}]
JSON
	timeout 120 pi -p --offline --approve --no-session -e /tmp/pkg -e /tmp/pkg/test/faux/faux-model.ts "go"
	echo "PI_EXIT=$?"
	grep -o "cannot find lake[^\"]*" .faux/turn-2.json | head -1
	grep -c "lean_diagnostics" .faux/turn-1.json | sed "s/^/TOOL_MENTIONS=/"
	timeout 60 pi -p --offline --approve --no-session -e /tmp/pkg -e /tmp/pkg/test/faux/faux-model.ts "/lean status" 2>&1
	echo "STATUS_EXIT=$?"
')"

assert_not_contains "the package is readable by the image user" "COPY_FAILED"       "$out"
assert_contains     "pi exits cleanly"                          "PI_EXIT=0"         "$out"
assert_contains     "the scripted run completed"                "SCRIPT-COMPLETE"   "$out"
assert_contains     "a missing lake is an answer, with the fix" "cannot find lake"  "$out"
assert_contains     "the fix names elan"                        "elan"              "$out"
assert_not_contains "the model was told about the tools"        "TOOL_MENTIONS=0"   "$out"
assert_contains     "/lean status runs and says what is missing" "lake: NOT FOUND"  "$out"
assert_contains     "/lean status exits cleanly"                "STATUS_EXIT=0"     "$out"

summary
