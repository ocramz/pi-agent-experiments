#!/usr/bin/env bash
# Start pi in a scratch directory with an extension and the prompt logger, then
# say where the log went.
#
#   cd pi-incremental-py && npm run dev:log
#   shared/dev/log-session.sh pi-incremental-py            # from the repo root
#   PI_PY_LOG_DIR=/workspace/log shared/dev/log-session.sh pi-incremental-py
#
# A scratch cwd rather than the repo, because the point is to watch an agent use
# the extension and the repo is not a realistic subject — pi would spend the
# session reading this file. Anything the session creates is left behind, named,
# so it can be looked at afterwards.
#
# Needs pi on PATH, so it needs the dev container: `make dev` then `make shell`.
set -euo pipefail

PKG="${1:-$(basename "$PWD")}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXTENSION="$ROOT/$PKG/extensions/index.ts"
LOGGER="$ROOT/shared/dev/pi-logger.ts"

[ -f "$EXTENSION" ] || {
	echo "no extension at $EXTENSION" >&2
	echo "usage: $0 <package-directory-name>" >&2
	exit 1
}

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pi-log-XXXXXX")"
export PI_PY_LOG_DIR="${PI_PY_LOG_DIR:-$SCRATCH/.pi-log}"

echo "cwd:  $SCRATCH"
echo "log:  $PI_PY_LOG_DIR"
echo
echo "Afterwards, e.g.:"
echo "  jq -r 'select(.event==\"prompt\") | .systemPrompt' $PI_PY_LOG_DIR/*.jsonl | head -1"
echo "  jq -c 'select(.event==\"context\")' $PI_PY_LOG_DIR/*.jsonl"
echo

# The logger goes last so its `context` handler sees post-filter messages — what
# the model was handed. Swap the two -e flags to record the raw transcript instead.
cd "$SCRATCH"
exec "${PI_BIN:-pi}" -e "$EXTENSION" -e "$LOGGER" "${@:2}"
