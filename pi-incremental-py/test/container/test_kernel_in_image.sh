#!/usr/bin/env bash
# The Python kernel's own suite, on a bare interpreter in the image.
#
# This is the gate. Two things it proves that no other tier does:
#
#   - The suite runs *at all* under automation. test-py/ is 50 unittest cases
#     plus a property module, and until now the only thing that ran them was a
#     human typing the command from the README. Neither `npm test`, `make check`
#     nor CI touched them.
#   - "The kernel is stdlib-only" is asserted rather than assumed. It used to
#     rest on the image having an empty site-packages, which was never quite
#     true (the interpreter ships pip) and stopped being true at all once
#     hypothesis was added for the property suite. `python3 -S` skips
#     site-packages outright, so importing the kernel under it proves the claim
#     no matter what else is installed alongside.
set -uo pipefail

# The kernel needs an interpreter, so this suite runs against the derived image
# rather than the default one. Set before lib.sh, which reads IMAGE with :?.
export IMAGE="${PY_TEST_IMAGE:?PY_TEST_IMAGE must be set — see shared/versions.env}"
source "$(dirname "$0")/../../../shared/test/container/lib.sh"

PKG="$(cd "$(dirname "$0")/../.." && pwd)"
STAGED="$(stage_pkg "$PKG")" || {
	echo "could not stage the package for the image user" >&2
	exit 1
}
trap 'rm -rf "$STAGED"' EXIT

out="$(RUN_FLAGS="-v $STAGED:/pkg:ro" in_image '
	mkdir -p /tmp/pkg || { echo "COPY_FAILED"; exit 1; }
	# Only the two halves the suite needs, and without the host is
	# __pycache__: a stale .pyc from the dev machine would be the one thing
	# capable of hiding a syntax-level regression from this exact check.
	cp -r /pkg/py /pkg/test-py /tmp/pkg/ || { echo "COPY_FAILED"; exit 1; }
	find /tmp/pkg -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null
	cd /tmp/pkg

	echo "USER_ID=$(id -u)"
	echo "PYVER=$(python3 -c "import sys; print(\"%d.%d\" % sys.version_info[:2])")"

	# -S drops site-packages, so this passes only if the kernel really does
	# import out of the standard library alone.
	if python3 -S -c "import sys; sys.path.insert(0, \"py\"); import kernel, protocol" 2>/dev/null; then
		echo "STDLIB_ONLY=yes"
	else
		echo "STDLIB_ONLY=no"
		python3 -S -c "import sys; sys.path.insert(0, \"py\"); import kernel, protocol" 2>&1 | tail -3
	fi

	python3 -m unittest discover -s test-py 2>&1 | tail -12
')"

assert_not_contains "the package is readable by the image user" "COPY_FAILED" "$out"
assert_contains     "runs as the unprivileged image user"       "USER_ID=65532" "$out"

# The floor is 3.12: py/kernel/analysis.py reads comprehension scopes the way PEP 709
# made them, and getting this wrong is a wrong dependency graph, not a crash.
version="$(printf '%s\n' "$out" | sed -n 's/^PYVER=//p')"
major="${version%%.*}"
minor="${version#*.}"
if [ "${major:-0}" -gt 3 ] 2>/dev/null || { [ "${major:-0}" -eq 3 ] && [ "${minor:-0}" -ge 12 ]; } 2>/dev/null; then
	ok "the image interpreter meets the 3.12 floor (found $version)"
else
	fail "the image interpreter meets the 3.12 floor" "expected >= 3.12" "actual: ${version:-none reported}"
fi

# A pass count, not just a green light: the suite once reported success in a
# sibling package while running nothing at all, which is what the floor is for.
ran="$(printf '%s\n' "$out" | sed -n 's/^Ran \([0-9][0-9]*\) test.*/\1/p' | tail -1)"
if [ "${ran:-0}" -ge 77 ] 2>/dev/null; then
	ok "the kernel suite actually ran ($ran tests)"
else
	fail "the kernel suite actually ran" "expected at least 77 tests" "actual: ${ran:-none reported}"
fi

assert_contains     "the kernel suite passed" "OK"     "$out"
assert_not_contains "no test failures"        "FAILED" "$out"

# The property module imports hypothesis unconditionally, so it cannot skip
# itself any more — the floor above counts its cases. Anything skipping here is
# a case quietly removing itself from the run, which is what this catches.
assert_not_contains "nothing skipped itself out of the run" "skipped" "$out"

assert_contains "the kernel imports from the standard library alone" "STDLIB_ONLY=yes" "$out"

summary
