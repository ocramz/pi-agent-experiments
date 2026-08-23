#!/usr/bin/env bash
# Assertion vocabulary shared by every shell-based suite in every package.
#
# Originally part of container/lib.sh, which cannot be sourced outside a
# container run — it opens by requiring IMAGE. Kept here so any shell-based suite
# can produce the same `  ok` / `FAIL` output; container/lib.sh sources it.
#
# Every helper takes the description first: assert_eq "what this proves" a b.

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

summary() {
	if [ "$FAIL" -eq 0 ]; then
		printf '%s%d passed%s\n' "$GREEN" "$PASS" "$RESET"
	else
		printf '%s%d passed, %d failed%s\n' "$RED" "$PASS" "$FAIL" "$RESET"
		exit 1
	fi
}
