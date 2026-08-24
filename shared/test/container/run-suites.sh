#!/usr/bin/env bash
# The generic container-test driver. Every package's test/container/run.sh is a
# thin wrapper that names its own suites and delegates here.
#
# Nothing below knows which package it is running. Everything it checks is a
# property of the engine and the image — that a container can start at all, that
# the image matches this CPU, that the inner image store is a real volume — which
# is exactly why it is shared rather than copied per package.
#
#   usage: run-suites.sh <suite.sh> [suite.sh ...]
#
# Suites run in the order given, in the caller's directory, and a failure in one
# does not stop the rest unless it is the first — see the gate below. Order is
# the caller's business: put the cheap gate first and the slow, costly tier last.
#
#   IMAGE=...            override the image (defaults to TEST_IMAGE from versions.env)
#   ENGINE=...           podman (default) or docker
#   PI_MODEL=, PI_PROVIDER=   what a live suite drives
#   REQUIRE_API_KEY=1    refuse to start without OPENROUTER_API_KEY
#   PI_ALLOW_UNMOUNTED_STORE=1   skip the inner-store guard
set -uo pipefail

if [ "$#" -eq 0 ]; then
	echo "usage: run-suites.sh <suite.sh> [suite.sh ...]" >&2
	exit 2
fi

# The suites are named relative to the *caller's* directory — that is where a
# package keeps them — so resolve them before anything else changes directory.
CALLER_DIR="${CALLER_DIR:-$PWD}"
SHARED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The pinned digest and the model defaults, from the one file that holds them.
# Exports IMAGE, PI_PROVIDER and PI_MODEL, leaving anything already set alone —
# which is how CI and `make check PI_MODEL=...` override without editing a file.
export SHARED_DIR
# shellcheck source=../../versions.sh
. "$SHARED_DIR/versions.sh"

export ENGINE="${ENGINE:-podman}"

# Only packages with a live tier need a key. Refusing loudly beats skipping
# quietly, same as the engine check below — but a package whose container tier is
# entirely offline should not be made to hold a credential it never spends.
if [ -n "${REQUIRE_API_KEY:-}" ] && [ -z "${OPENROUTER_API_KEY:-}" ]; then
	echo "OPENROUTER_API_KEY is not set — the live extension suite cannot run." >&2
	echo "Set it in .env at the repo root (see env.example), then use 'make test-container'." >&2
	exit 78
fi

# lib.sh splices USER_FLAGS into every `podman run` it issues, so this is the
# whole of the hand-off inward. The distroless image points HOME and
# PI_CODING_AGENT_DIR at read-only paths; /tmp is all uid 65532 can write.
export USER_FLAGS="${USER_FLAGS:-} -e OPENROUTER_API_KEY -e TAVILY_API_KEY -e PI_PROVIDER -e PI_MODEL -e HOME=/tmp -e PI_CODING_AGENT_DIR=/tmp/agent"

if ! command -v "$ENGINE" >/dev/null 2>&1; then
	echo "no container engine: '$ENGINE' is not on PATH" >&2
	echo "install podman, or set ENGINE=docker" >&2
	exit 127
fi

# The inner image store must be a dedicated volume. Without one every layer a
# pull or build writes lands on the dev container's overlay — 8 GB, shared with
# the toolchain — and fills it silently; that is how this rig once ate 2.1 GB.
# `make dev` mounts STORAGE_VOL there; a container started any other way does not.
# This runs before the smoke test below, which would itself write into the store.
# Only meaningful when nested: on a CI runner podman is not itself in a container
# and its graphroot is legitimately a plain directory.
if [ -z "${PI_ALLOW_UNMOUNTED_STORE:-}" ] && { [ -f /run/.containerenv ] || [ -f /.dockerenv ]; }; then
	graphroot="$("$ENGINE" info --format '{{.Store.GraphRoot}}' 2>/dev/null)"
	if [ -n "$graphroot" ] && command -v findmnt >/dev/null 2>&1 &&
		[ "$(findmnt -T "$graphroot" -no TARGET 2>/dev/null)" != "$graphroot" ]; then
		echo "the inner image store '$graphroot' is not a mounted volume." >&2
		echo "Pulling into it fills this container's overlay filesystem." >&2
		echo "Start the dev container with 'make dev', which mounts STORAGE_VOL there." >&2
		echo "Set PI_ALLOW_UNMOUNTED_STORE=1 to run anyway." >&2
		exit 1
	fi
fi

# Prove the engine can actually start a container before running any suite.
# Without this, a sandbox that blocks mount propagation or lacks /dev/fuse makes
# every assertion fail and the run reports the first suite as broken — which
# sends the reader after entirely the wrong problem.
if ! smoke="$("$ENGINE" run --rm --entrypoint /bin/bash "$IMAGE" -c 'echo engine-ok' 2>&1)" ||
	[ "${smoke#*engine-ok}" = "$smoke" ]; then
	# An architecture mismatch fails here too, and it is not an engine fault: the
	# engine is fine, the image is for another CPU. `podman pull` by digest does
	# not enforce a platform, so a per-platform digest pulls cleanly and only dies
	# at `run` — pointing the reader at their engine sends them nowhere.
	case "$smoke" in
	*"Exec format error"* | *"does not match the expected platform"*)
		echo "the image is built for a different architecture than this host — the tests were not run." >&2
		printf '%s\n' "$smoke" | head -3 >&2
		echo "IMAGE must be pinned to the multi-arch index digest, not to one platform's" >&2
		echo "manifest; see the TEST_IMAGE comment in shared/versions.env for how to re-pin." >&2
		exit 127
		;;
	esac
	echo "container engine '$ENGINE' cannot run containers here — the tests were not run." >&2
	printf '%s\n' "$smoke" | head -3 >&2
	echo "Run these on a machine with a working engine, or in CI." >&2
	exit 127
fi

cd "$CALLER_DIR" || exit 1

status=0
first=1
for script in "$@"; do
	[ -f "$script" ] || continue
	printf '\n=== %s ===\n' "$script"
	bash "$script" || status=1
	# The first suite is the gate: a caller puts its cheapest, most fundamental
	# check there — the git capability probe, say — and if the ground assumption
	# is false every later failure is noise.
	if [ "$first" = 1 ] && [ "$status" -ne 0 ]; then
		echo "'$script' failed — stopping before the dependent suites" >&2
		exit 1
	fi
	first=0
done

exit "$status"
