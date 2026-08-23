#!/usr/bin/env bash
# Vendored from ocramz/pi-container-distroless-node24 (tests/lib.sh), kept in-tree
# so the container tests are self-contained — no submodule, no fetch at test time.
# The harness is short and stable; re-sync it if upstream changes.
#
# Shared by every package in this repo: nothing here knows which package it is
# staging, and stage_pkg takes the directory as an argument.
#
#   ENGINE     container engine (default: podman)
#   IMAGE      image to test against — pin a digest, never :latest
#   FIXTURES   fixture directory, mounted read-only
#   RUN_FLAGS  extra engine flags for one call (e.g. --network=none, -v ...)
set -uo pipefail

# ok / fail / assert_* / summary.
source "$(dirname "${BASH_SOURCE[0]}")/../assert.sh"

ENGINE="${ENGINE:-podman}"
IMAGE="${IMAGE:?IMAGE must be set — see TEST_IMAGE in shared/versions.env}"
FIXTURES="${FIXTURES:-$(cd "$(dirname "${BASH_SOURCE[0]}")/fixtures" 2>/dev/null && pwd)}"
USER_FLAGS="${USER_FLAGS:-}"

# Copy the package somewhere the image user can actually read it, and echo the path.
#
# Binding the checkout straight into the image does not work when the tests run
# from a devcontainer on macOS: podman machine's virtiofs presents every host
# file as root-owned 0600 no matter what its real mode is, so uid 65532 cannot
# open a single source file and the suite fails on `cp: Permission denied`. A
# staged copy with normalised modes costs a few hundred milliseconds and behaves
# the same on Linux, where the modes were fine to begin with.
#
# Every node_modules is excluded during the copy rather than deleted after it,
# and at any depth. None belongs in the image: a package's own is a tree of
# symlinks into the global pi install, and the two big shared scopes —
# shared/typecheck (260 MB of pi and its provider SDKs) and shared/test/tui —
# are outside the staged directory entirely now, which is a second reason the
# copy stays cheap. Deleting them afterwards, as this used to, still pays to
# copy them first.
stage_pkg() {
	local src="$1" dest
	dest="$(mktemp -d)" || return 1
	tar -cf - -C "$src" --exclude=node_modules . | tar -xpf - -C "$dest" || return 1
	chmod -R a+rX "$dest" || return 1
	printf '%s' "$dest"
}

# Run a bash snippet inside the image. The entrypoint is `pi`, so it is overridden.
in_image() {
	# shellcheck disable=SC2086  # word splitting of the flag strings is intended
	$ENGINE run --rm $USER_FLAGS ${RUN_FLAGS:-} --entrypoint /bin/bash "$IMAGE" -c "$*" 2>&1
}

# Run the image's entrypoint (pi) with arguments.
run_pi() {
	# shellcheck disable=SC2086
	$ENGINE run --rm $USER_FLAGS ${RUN_FLAGS:-} "$IMAGE" "$@" 2>&1
}
