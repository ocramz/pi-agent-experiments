#!/usr/bin/env bash
# Vendored from ocramz/pi-container-distroless-node24 (tests/lib.sh), kept in-tree
# so this package's container tests are self-contained — no submodule, no fetch at
# test time. The harness is short and stable; re-sync it if upstream changes.
#
#   ENGINE     container engine (default: podman)
#   IMAGE      image to test against — pin a tag, never :latest
#   FIXTURES   fixture directory, mounted read-only
#   RUN_FLAGS  extra engine flags for one call (e.g. --network=none, -v ...)
set -uo pipefail

ENGINE="${ENGINE:-podman}"
IMAGE="${IMAGE:?IMAGE must be set (e.g. ghcr.io/ocramz/pi-container-distroless-node24:latest)}"
FIXTURES="${FIXTURES:-$(cd "$(dirname "${BASH_SOURCE[0]}")/fixtures" 2>/dev/null && pwd)}"
USER_FLAGS="${USER_FLAGS:-}"

PASS=0
FAIL=0
if [ -t 1 ]; then GREEN=$'\033[32m'; RED=$'\033[31m'; RESET=$'\033[0m'; else GREEN=''; RED=''; RESET=''; fi

ok() {
	PASS=$((PASS + 1))
	printf '%s  ok%s %s\n' "$GREEN" "$RESET" "$1"
}

fail() {
	FAIL=$((FAIL + 1))
	printf '%sFAIL%s %s\n' "$RED" "$RESET" "$1"
	shift
	for message in "$@"; do printf '       %s\n' "$message"; done
}

assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "expected: $2" "actual:   $3"; fi; }

assert_contains() {
	case "$3" in
	*"$2"*) ok "$1" ;;
	*) fail "$1" "expected to contain: $2" "actual: $(printf '%s' "$3" | head -c 500)" ;;
	esac
}

assert_not_contains() {
	case "$3" in
	*"$2"*) fail "$1" "expected NOT to contain: $2" "actual: $(printf '%s' "$3" | head -c 500)" ;;
	*) ok "$1" ;;
	esac
}

assert_ok() { if [ "$2" = "0" ]; then ok "$1"; else fail "$1" "exit code: $2"; fi; }

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

summary() {
	if [ "$FAIL" -eq 0 ]; then
		printf '%s%d passed%s\n' "$GREEN" "$PASS" "$RESET"
	else
		printf '%s%d passed, %d failed%s\n' "$RED" "$PASS" "$FAIL" "$RESET"
		exit 1
	fi
}
