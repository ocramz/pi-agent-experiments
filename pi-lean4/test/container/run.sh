#!/usr/bin/env bash
# The container tier for pi-lean4.
#
# No REQUIRE_API_KEY: both suites are offline (the extension is driven by the
# scripted faux model). The image has no Lean, and that is the point here: the
# unit suites prove the package needs nothing but pi's own runtime, and the
# extension suite proves pi survives — with an answer the model can act on —
# on a machine with no toolchain. Real Lean is test/lean/, on the host.
set -uo pipefail
cd "$(dirname "$0")"

CALLER_DIR="$PWD" exec ../../../shared/test/container/run-suites.sh \
	test_unit_in_image.sh \
	test_extension_in_image.sh
