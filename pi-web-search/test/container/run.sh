#!/usr/bin/env bash
# The container tier for pi-web-search.
#
# No REQUIRE_API_KEY: the suite here is offline (fetch is stubbed), and the
# live coverage of the extension entry point lives in test/tui/live.test.ts,
# same split as pi-incremental-py. What only a container reaches is the
# *userland* — an unprivileged uid, HOME forced to /tmp, no node_modules —
# so that is what the suite asserts.
set -uo pipefail
cd "$(dirname "$0")"

CALLER_DIR="$PWD" exec ../../../shared/test/container/run-suites.sh \
	test_unit_in_image.sh
