#!/usr/bin/env bash
# The suites that test the *image*, not any package.
#
# The git capability probe asserts what the pinned image's perl-less git can do.
# That answer is a property of the image alone, so running it once per package
# would re-probe the same digest N times for the same result. `make test-image`
# runs this, and `make check` runs it first — the capability probe is the gate on
# every design that assumes worktrees or `stash create` exist.
#
# No API key: nothing here drives a model.
set -uo pipefail

cd "$(dirname "$0")"

CALLER_DIR="$PWD" exec ./run-suites.sh test_git_capabilities.sh
