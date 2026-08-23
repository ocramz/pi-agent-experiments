# Put the shared pins in the environment. Source this; do not execute it.
#
#   SHARED_DIR=/path/to/shared . "$SHARED_DIR/versions.sh"
#
# The caller sets SHARED_DIR because a sourced file cannot portably locate
# itself: `${BASH_SOURCE[0]}` is a bash array expansion and dash — which is what
# npm runs package scripts under on Debian — rejects it outright. Callers that
# would rather not think about it use with-versions.sh instead.
#
# versions.env carries DEFAULT_-prefixed names. Each maps to its real name only
# if that name is unset, so anything already in the environment wins:
# `make check PI_MODEL=...`, a CI job's `env:`, a one-off `IMAGE=... run.sh`.
# Sourcing versions.env directly would silently overwrite all three.

# shellcheck disable=SC1091  # resolved at runtime from the caller's SHARED_DIR
. "${SHARED_DIR:?SHARED_DIR must be set before sourcing versions.sh}/versions.env"

export TEST_IMAGE="${TEST_IMAGE:-$DEFAULT_TEST_IMAGE}"
export PI_PROVIDER="${PI_PROVIDER:-$DEFAULT_PI_PROVIDER}"
export PI_MODEL="${PI_MODEL:-$DEFAULT_PI_MODEL}"
export PI_VERSION="${PI_VERSION:-$DEFAULT_PI_VERSION}"

# The container harness reads IMAGE, not TEST_IMAGE — the two names are historic
# and both are load-bearing (lib.sh requires IMAGE; the Makefile exposes
# TEST_IMAGE). Bridge them here rather than in each caller.
export IMAGE="${IMAGE:-$TEST_IMAGE}"
