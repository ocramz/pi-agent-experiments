#!/usr/bin/env bash
# The container tier for pi-notebook-py.
#
# Ordered cheapest and most fundamental first, because run-suites.sh treats the
# first suite as a hard gate: if the kernel cannot pass its own unit suite on a
# bare interpreter, nothing below it is worth the time.
#
# No REQUIRE_API_KEY: nothing here drives a model. test/tui/live.test.ts already
# covers a real model reaching nb_cell and nb_install. What only a container
# reaches is the *userland* — no .notebook/, no site-packages, an unprivileged
# uid with HOME forced to /tmp — so that is what these suites are about.
#
# The image is PY_TEST_IMAGE, shared with pi-incremental-py: the pinned pi
# userland plus a 3.13 interpreter and hypothesis. This package needs nothing
# added to it, so there is deliberately no Containerfile here.
set -uo pipefail
cd "$(dirname "$0")"

SHARED_DIR="$(cd ../../../shared && pwd)" . ../../../shared/versions.sh
if [ -z "${PY_TEST_IMAGE:-}" ]; then
	echo "DEFAULT_PY_TEST_IMAGE is unset in shared/versions.env — this tier needs an" >&2
	echo "image with a Python in it. See pi-incremental-py/test/container/Containerfile." >&2
	exit 1
fi
export PY_TEST_IMAGE

CALLER_DIR="$PWD" exec ../../../shared/test/container/run-suites.sh \
	test_kernel_in_image.sh \
	test_protocol_in_image.sh \
	test_unit_in_image.sh \
	test_plot_in_image.sh
