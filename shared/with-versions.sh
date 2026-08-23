#!/usr/bin/env bash
# Run a command with the shared pins in its environment.
#
#   ../shared/with-versions.sh node --test 'test/tui/*.test.ts'
#
# This is the form npm package scripts use: it needs no sourcing, so it does not
# care that npm runs scripts under a shell without bash's array expansions, and
# it needs no quoting gymnastics inside package.json.
#
# Anything already exported wins over the file — see versions.sh.
set -euo pipefail

SHARED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SHARED_DIR
# shellcheck source=./versions.sh
. "$SHARED_DIR/versions.sh"

exec "$@"
