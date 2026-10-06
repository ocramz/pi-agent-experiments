#!/usr/bin/env bash
# This package's container tests, cheapest first.
#
# test_unit_in_image.sh is the hard gate: the unit suite in the bare image
# userland. test_harbor_scenarios.sh runs Harbor's own ATIF validator over every
# unit scenario — the check that the unit tier's ported validator still agrees
# with the real one. test_extension_live.sh is last: it is the only suite that
# spends money, which is also why REQUIRE_API_KEY is set.
#
# The last two need Python for the validator, so they run in PY_TEST_IMAGE (the
# pinned image plus an interpreter — see shared/versions.env) rather than IMAGE.
set -uo pipefail

cd "$(dirname "$0")"

REQUIRE_API_KEY=1 CALLER_DIR="$PWD" \
	exec ../../../shared/test/container/run-suites.sh \
	test_unit_in_image.sh \
	test_harbor_scenarios.sh \
	test_extension_live.sh
