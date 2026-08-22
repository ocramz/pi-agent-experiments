#!/usr/bin/env bash
# Re-run the host unit suite inside the image.
#
# Nearly free — it reuses test/ wholesale — and it is the only thing that proves
# the logic survives the image's actual userland: perl-less git, busybox coreutils,
# and an unprivileged user who can only write under /tmp.
#
# The package is mounted read-only and copied to /tmp first, because the tests
# create repositories and databases.
source "$(dirname "$0")/lib.sh"

PKG="$(cd "$(dirname "$0")/../.." && pwd)"

out="$(RUN_FLAGS="--network=none -v $PKG:/pkg:ro" in_image '
	cp -r /pkg /tmp/pkg && cd /tmp/pkg
	rm -rf node_modules            # symlinks into a host path; not needed to run tests
	echo "USER_ID=$(id -u)"
	node --test "test/**/*.test.ts" 2>&1 | tail -20
')"

assert_contains "runs as the unprivileged image user" "USER_ID=65532" "$out"
assert_contains "no test failures"                    "fail 0"        "$out"
assert_not_contains "no test was cancelled"           "cancelled 1"   "$out"

summary
