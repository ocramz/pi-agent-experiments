#!/usr/bin/env bash
# Run every container test, in dependency order.
#
# Requires a container engine and an OpenRouter key. test_git_capabilities.sh
# runs first on purpose: it is the gate on the design, so a failure there should
# stop the run rather than be buried under later output. test_extension_live.sh
# runs last: it is the slowest and the only one that spends money.
#
#   IMAGE=...  override the image (pin a digest in CI)
#   ENGINE=... podman (default) or docker
#   PI_MODEL=, PI_PROVIDER=  what the live suite drives
set -uo pipefail

cd "$(dirname "$0")"

export IMAGE="${IMAGE:-ghcr.io/ocramz/pi-container-distroless-node24:latest}"
export ENGINE="${ENGINE:-podman}"
export PI_PROVIDER="${PI_PROVIDER:-openrouter}"
export PI_MODEL="${PI_MODEL:-deepseek/deepseek-v4-flash}"

# test_extension_live.sh drives a real model, which is the only way to reach the
# extension at all — everything in extensions/index.ts hangs off a pi runtime.
# Refusing loudly beats skipping quietly, same as the engine check below.
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
	echo "OPENROUTER_API_KEY is not set — the live extension suite cannot run." >&2
	echo "Set it in .env at the repo root (see env.example), then use 'make test-container'." >&2
	exit 78
fi

# lib.sh splices USER_FLAGS into every `podman run` it issues, so this is the
# whole of the hand-off inward. The distroless image points HOME and
# PI_CODING_AGENT_DIR at read-only paths; /tmp is all uid 65532 can write.
export USER_FLAGS="${USER_FLAGS:-} -e OPENROUTER_API_KEY -e PI_PROVIDER -e PI_MODEL -e HOME=/tmp -e PI_CODING_AGENT_DIR=/tmp/agent"

if ! command -v "$ENGINE" >/dev/null 2>&1; then
	echo "no container engine: '$ENGINE' is not on PATH" >&2
	echo "install podman, or set ENGINE=docker" >&2
	exit 127
fi

# Prove the engine can actually start a container before running any suite.
# Without this, a sandbox that blocks mount propagation or lacks /dev/fuse makes
# every assertion fail and the run reports "git capability probe failed" — which
# sends the reader after entirely the wrong problem.
if ! smoke="$("$ENGINE" run --rm --entrypoint /bin/bash "$IMAGE" -c 'echo engine-ok' 2>&1)" ||
	[ "${smoke#*engine-ok}" = "$smoke" ]; then
	echo "container engine '$ENGINE' cannot run containers here — the tests were not run." >&2
	printf '%s\n' "$smoke" | head -3 >&2
	echo "Run these on a machine with a working engine, or in CI." >&2
	exit 127
fi

status=0
for script in test_git_capabilities.sh test_unit_in_image.sh test_extension_live.sh; do
	[ -f "$script" ] || continue
	printf '\n=== %s ===\n' "$script"
	bash "$script" || status=1
	# The capability probe gates the rest: if git cannot do what the design
	# assumes, later failures are noise.
	if [ "$script" = "test_git_capabilities.sh" ] && [ "$status" -ne 0 ]; then
		echo "git capability probe failed — stopping before the dependent suites" >&2
		exit 1
	fi
done

exit "$status"
