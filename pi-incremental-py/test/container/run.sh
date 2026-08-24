#!/usr/bin/env bash
# The container tier for pi-incremental-py.
#
# Ordered cheapest and most fundamental first, because run-suites.sh treats the
# first suite as a hard gate: if the kernel cannot pass its own unit suite on a
# bare interpreter, nothing below it is worth the time.
#
# No REQUIRE_API_KEY: nothing here drives a model. test/tui/live.test.ts already
# covers a real model reaching py_cell and py_install, and repeating that in a
# container would spend money to re-cover it. What only a container reaches is
# the *userland* — no .incremental/, no site-packages, an unprivileged uid with
# HOME forced to /tmp — so that is what these suites are about.
#
# Two images are in play. Suites needing Python use PY_TEST_IMAGE (the pinned
# image plus an interpreter, built from ./Containerfile); test_no_python.sh
# deliberately uses the default IMAGE, which has none.
set -uo pipefail
cd "$(dirname "$0")"

# PY_TEST_IMAGE is normally a pinned digest from shared/versions.env, pulled
# like any other. Empty means it has not been published yet (or someone is
# iterating on the Containerfile), in which case build it here and say so
# loudly — a locally built image is not a pinned one, and a run against it
# proves less than a run against the published digest.
SHARED_DIR="$(cd ../../../shared && pwd)" . ../../../shared/versions.sh
if [ -z "${PY_TEST_IMAGE:-}" ]; then
	PY_TEST_IMAGE=localhost/pi-incremental-py-test:local
	echo "note: DEFAULT_PY_TEST_IMAGE is unset — building $PY_TEST_IMAGE locally."
	echo "      Publish it with .github/workflows/publish-py-image.yml and pin the"
	echo "      digest it prints, so this tier runs against a known image."
	"${ENGINE:-podman}" build -t "$PY_TEST_IMAGE" -f Containerfile . >/dev/null || {
		echo "could not build the python test image" >&2
		exit 1
	}
fi
export PY_TEST_IMAGE

CALLER_DIR="$PWD" exec ../../../shared/test/container/run-suites.sh \
	test_kernel_in_image.sh \
	test_protocol_in_image.sh \
	test_no_python.sh \
	test_unit_in_image.sh \
	test_install_in_image.sh
