#!/usr/bin/env bash
# Every unit scenario, through Harbor's own ATIF validator.
#
# The unit tier checks its trajectories against test/atif-check.ts, which is a
# port of Harbor's pydantic models. A port drifts: Harbor tightens a rule, the
# port does not, and the unit tier goes on reporting valid files that Harbor
# would reject. This suite closes that loop by handing the very same scenarios
# (test/container/emit-scenarios.ts) to `python -m harbor.utils.trajectory_validator`
# at the pinned release. Images are written beside each file, so the
# validator's file-exists check runs too.
#
# Needs the network (PyPI), but no API key.
set -uo pipefail

export IMAGE="${PY_TEST_IMAGE:?PY_TEST_IMAGE must be set — see shared/versions.env}"
source "$(dirname "$0")/../../../shared/test/container/lib.sh"
source "$(dirname "$0")/harbor.sh"

PKG="$(cd "$(dirname "$0")/../.." && pwd)"
STAGED="$(stage_pkg "$PKG")" || {
	echo "could not stage the package for the image user" >&2
	exit 1
}
trap 'rm -rf "$STAGED"' EXIT

out="$(RUN_FLAGS="-v $STAGED:/pkg:ro $HARBOR_FLAGS" in_image "
	cp -r /pkg /tmp/pkg || { echo COPY_FAILED; exit 1; }
	cd /tmp/pkg
	$INSTALL_HARBOR
	node test/container/emit-scenarios.ts /tmp/scen > /tmp/emit.log 2>&1 || { echo EMIT_FAILED; cat /tmp/emit.log; exit 1; }
	echo EMITTED=\$(ls /tmp/scen/*.atif.json | wc -l)
	valid=0
	for f in /tmp/scen/*.atif.json; do
		if /tmp/hv/bin/python -m harbor.utils.trajectory_validator \"\$f\" > /tmp/v.log 2>&1; then
			valid=\$((valid + 1))
		else
			echo \"REJECTED=\$(basename \"\$f\")\"
			cat /tmp/v.log
		fi
	done
	echo VALID=\$valid
")"

assert_not_contains "the package is readable by the image user" "COPY_FAILED"    "$out"
assert_not_contains "Harbor installed from PyPI"                "INSTALL_FAILED" "$out"
assert_contains     "the validator is the pinned release"       "HARBOR=$HARBOR_VERSION" "$out"
assert_not_contains "every scenario converted"                  "EMIT_FAILED"    "$out"
assert_not_contains "Harbor rejected no scenario"               "REJECTED="      "$out"

emitted="$(printf '%s\n' "$out" | sed -n 's/^EMITTED=\([0-9][0-9]*\)$/\1/p')"
valid="$(printf '%s\n' "$out" | sed -n 's/^VALID=\([0-9][0-9]*\)$/\1/p')"
# A floor as well as a match: zero of zero would also "all pass".
if [ "${emitted:-0}" -ge 10 ] 2>/dev/null && [ "$valid" = "$emitted" ]; then
	ok "Harbor accepted all $valid scenarios"
else
	fail "Harbor accepted every scenario" "emitted: ${emitted:-none}" "valid:   ${valid:-none}"
fi

summary
