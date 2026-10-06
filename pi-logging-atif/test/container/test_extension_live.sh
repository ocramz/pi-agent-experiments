#!/usr/bin/env bash
# A real model, a real pi, and Harbor's validator on what came out.
#
# The faux tier (test/tui/) covers the wiring for free, but a faux provider
# reports estimated token counts and no cost, and mints its own tool-call ids.
# Only a real provider shows that usage, cost and provider-issued ids survive
# the trip into ATIF — and that the result is a trajectory Harbor accepts.
#
# Also the one place `--no-session` is exercised: pi persists nothing there, and
# the extension must still write, because PI_ATIF_DIR was set explicitly.
#
# Assertions target the file, never the assistant's prose. Runs in PY_TEST_IMAGE
# (the pinned image plus Python) so the validator can run in the same container.
#
# Every pi call is wrapped in `timeout`: a model with a bash tool has no natural
# stopping point, and an unbounded live test is one curious model away from
# wedging CI.
set -uo pipefail

export IMAGE="${PY_TEST_IMAGE:?PY_TEST_IMAGE must be set — see shared/versions.env}"
source "$(dirname "$0")/../../../shared/test/container/lib.sh"
source "$(dirname "$0")/harbor.sh"

PI_TIMEOUT="${PI_TIMEOUT:-240}"
: "${PI_PROVIDER:?PI_PROVIDER must be set}"
: "${PI_MODEL:?PI_MODEL must be set}"

PROBE=atif-live-probe

PKG="$(cd "$(dirname "$0")/../.." && pwd)"
STAGED="$(stage_pkg "$PKG")" || {
	echo "could not stage the package for the image user" >&2
	exit 1
}
trap 'rm -rf "$STAGED"' EXIT

out="$(RUN_FLAGS="-v $STAGED:/pkg:ro -e PI_TIMEOUT=$PI_TIMEOUT -e PROBE=$PROBE $HARBOR_FLAGS" in_image "
	cp -r /pkg /tmp/pkg || { echo COPY_FAILED; exit 1; }
	$INSTALL_HARBOR
	mkdir -p /tmp/work && cd /tmp/work
	echo USER_ID=\$(id -u)

	PI_ATIF_DIR=/tmp/atif timeout \"\$PI_TIMEOUT\" pi --print --no-session --tools bash \
		--provider \"\$PI_PROVIDER\" --model \"\$PI_MODEL\" \
		-e /tmp/pkg/extensions/index.ts \
		\"Use the bash tool to run exactly this command: echo \$PROBE . Then reply with one short sentence.\" \
		> /tmp/pi.log 2>&1
	case \$? in 124 | 137 | 143) echo PI_TIMED_OUT=yes ;; esac
	tail -3 /tmp/pi.log

	echo FILES=\$(ls /tmp/atif/*.atif.json 2>/dev/null | wc -l)
	f=\$(ls /tmp/atif/*.atif.json 2>/dev/null | head -1)
	[ -n \"\$f\" ] || exit 0
	if /tmp/hv/bin/python -m harbor.utils.trajectory_validator \"\$f\" > /tmp/v.log 2>&1; then
		echo HARBOR_VALID=yes
	else
		echo HARBOR_VALID=no; cat /tmp/v.log
	fi
	node /tmp/pkg/test/container/inspect-live.ts \"\$f\" \"\$PROBE\"
")"

assert_not_contains "the package is readable by the image user"    "COPY_FAILED"          "$out"
assert_not_contains "Harbor installed from PyPI"                   "INSTALL_FAILED"       "$out"
assert_contains     "runs as the unprivileged image user"          "USER_ID=65532"        "$out"
assert_not_contains "pi finished inside its time budget"           "PI_TIMED_OUT=yes"     "$out"
assert_contains     "one trajectory, written under --no-session"   "FILES=1"              "$out"
assert_contains     "Harbor's validator accepts it"                "HARBOR_VALID=yes"     "$out"
assert_contains     "the system prompt was captured at agent_start" "PROMPT_CAPTURED=yes" "$out"
assert_contains     "the model's bash call was recorded"           "PROBE_CALLED=yes"     "$out"
assert_contains     "its output is an observation pinned to it"    "PROBE_OBSERVED=yes"   "$out"
assert_contains     "every agent step has token counts"            "TOKENS_COUNTED=yes"   "$out"
assert_contains     "every agent step records a cost"              "COST_RECORDED=yes"    "$out"
assert_contains     "every agent step names its model"             "MODEL_NAMED=yes"      "$out"
assert_contains     "final_metrics sums the steps"                 "TOTALS_MATCH=yes"     "$out"
assert_contains     "bash is the one tool definition (--tools)"    "TOOL_DEFINITIONS=bash" "$out"

summary
