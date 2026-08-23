#!/usr/bin/env bash
# This package's container tests, in dependency order.
#
# Everything generic — the engine smoke test, the architecture diagnostics, the
# inner-store guard, the pinned digest — lives in the shared driver. All that is
# left here is which suites to run and in what order.
#
# test_unit_in_image.sh runs first: it is cheap and it proves the package is even
# readable to the image user. test_extension_live.sh runs last: it is the slowest
# and the only one that spends money, which is also why REQUIRE_API_KEY is set.
#
# The image's git capabilities are probed once for the whole repo rather than
# once per package — see `make test-image` and
# shared/test/container/test_git_capabilities.sh.
set -uo pipefail

cd "$(dirname "$0")"

REQUIRE_API_KEY=1 CALLER_DIR="$PWD" \
	exec ../../../shared/test/container/run-suites.sh \
	test_unit_in_image.sh \
	test_extension_live.sh
