#!/usr/bin/env bash
# The JSON-lines protocol, spoken by a foreign process.
#
# No node and no pi here: this drives py/protocol.py over a pipe exactly as
# anything else would. That is the premise of `--serve` and of docs/remote.md,
# and the TypeScript tiers cannot check it — they only ever see the protocol
# through src/kernel.ts, which is the one client guaranteed to agree with it.
#
# Every assertion keys on the wire, and each headline claim is paired with a
# control, because "cached" is only evidence of early cutoff if the same setup
# reports "ran" when the value genuinely changes.
set -uo pipefail

export IMAGE="${PY_TEST_IMAGE:?PY_TEST_IMAGE must be set — see shared/versions.env}"
source "$(dirname "$0")/../../../shared/test/container/lib.sh"

PKG="$(cd "$(dirname "$0")/../.." && pwd)"
STAGED="$(stage_pkg "$PKG")" || {
	echo "could not stage the package for the image user" >&2
	exit 1
}
trap 'rm -rf "$STAGED"' EXIT

# ── the wire ────────────────────────────────────────────────────────
out="$(RUN_FLAGS="-v $STAGED:/pkg:ro" in_image '
	mkdir -p /tmp/pkg && cp -r /pkg/py /tmp/pkg/ || { echo "COPY_FAILED"; exit 1; }
	cd /tmp/pkg
	echo "USER_ID=$(id -u)"

	cat > /tmp/drive.py <<"PY"
import json, subprocess, sys

p = subprocess.Popen(
    [sys.executable, "py/protocol.py", "--serve"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
)

def call(req):
    p.stdin.write(json.dumps(req) + "\n")
    p.stdin.flush()
    line = p.stdout.readline()
    # A cell printing to stdout must never reach this stream. If it did,
    # this parse is where the protocol would be caught corrupting itself.
    return json.loads(line)

def statuses(resp):
    return {r["cell"]: r["status"] for r in resp["results"]}

# Early cutoff: the source of `a` changes, the value it produces does not,
# so `b` keys the same and must not re-run.
ida = call({"tool": "add_cell", "src": "a = 1"})["id"]
idb = call({"tool": "add_cell", "src": "b = a + 1"})["id"]
same = statuses(call({"tool": "set_cell", "id": ida, "src": "a = 2 - 1"}))
print("CUTOFF_A=" + same.get(ida, "absent"))
print("CUTOFF_B=" + same.get(idb, "absent"))

# The control. Same edit shape, different value: now `b` has to re-run.
changed = statuses(call({"tool": "set_cell", "id": ida, "src": "a = 99"}))
print("CHANGED_A=" + changed.get(ida, "absent"))
print("CHANGED_B=" + changed.get(idb, "absent"))

# Failure isolation: a dependent of a broken cell is skipped, not poisoned.
idc = call({"tool": "add_cell", "src": "c = 10"})["id"]
idd = call({"tool": "add_cell", "src": "d = c + 1"})["id"]
broke = call({"tool": "set_cell", "id": idc, "src": "c = 1 / 0"})
print("FAILING_HAS_C=" + str(idc in broke["failing"]))
print("PENDING_HAS_D=" + str(idd in broke["pending"]))
fixed = call({"tool": "set_cell", "id": idc, "src": "c = 41"})
print("RECOVERED_D=" + str(fixed["globals"].get("d")))
print("FAILING_EMPTY=" + str(fixed["failing"] == []))
print("PENDING_EMPTY=" + str(fixed["pending"] == []))

# The server never dies mid-line: a bad request is answered, and the next
# request on the very next line still gets a response.
bad = call({"tool": "no_such_tool"})
print("UNKNOWN_OK=" + str(bad["ok"]))
print("UNKNOWN_NAMED=" + str("unknown tool" in bad.get("error", "")))
print("ALIVE_AFTER_UNKNOWN=" + str(call({"tool": "inspect"})["ok"]))

# An expected error is a plain failure, not an internal one. The flag is the
# only signal a caller has for "this is a kernel bug, not your mistake".
missing = call({"tool": "set_cell", "id": "zzzzzz", "src": "x = 1"})
print("BADID_OK=" + str(missing["ok"]))
print("BADID_INTERNAL=" + str(missing.get("internal", False)))
print("ALIVE_AFTER_ERROR=" + str(call({"tool": "inspect"})["ok"]))

# Cell output is captured into the result, never written to the pipe.
noisy = call({"tool": "add_cell", "src": "print(\"noise\")\n7"})
print("PRINT_OK=" + str(noisy["ok"]))
print("PRINT_CAPTURED=" + str("noise" in noisy["results"][0]["output"]))
print("PRINT_VALUE=" + str(noisy["results"][0]["value"]))
PY

	python3 /tmp/drive.py 2>&1
')"

assert_not_contains "the package is readable by the image user" "COPY_FAILED"  "$out"
assert_contains     "runs as the unprivileged image user"       "USER_ID=65532" "$out"

assert_contains "the edited cell re-runs"                    "CUTOFF_A=ran"      "$out"
assert_contains "early cutoff spares the unchanged dependent" "CUTOFF_B=cached"  "$out"
assert_contains "the control still re-runs the edited cell"  "CHANGED_A=ran"     "$out"
assert_contains "a real value change propagates"             "CHANGED_B=ran"     "$out"

assert_contains "a raising cell is reported failing"     "FAILING_HAS_C=True" "$out"
assert_contains "its dependent is pending, not poisoned" "PENDING_HAS_D=True" "$out"
assert_contains "fixing the cell revives the dependent"  "RECOVERED_D=42"     "$out"
assert_contains "nothing is left failing"                "FAILING_EMPTY=True" "$out"
assert_contains "nothing is left pending"                "PENDING_EMPTY=True" "$out"

assert_contains "an unknown tool is refused"             "UNKNOWN_OK=False"        "$out"
assert_contains "the refusal names the problem"          "UNKNOWN_NAMED=True"      "$out"
assert_contains "the server survives an unknown tool"    "ALIVE_AFTER_UNKNOWN=True" "$out"
assert_contains "an unknown cell id is refused"          "BADID_OK=False"          "$out"
assert_contains "an expected error is not flagged internal" "BADID_INTERNAL=False" "$out"
assert_contains "the server survives an expected error"  "ALIVE_AFTER_ERROR=True"  "$out"

assert_contains "a printing cell does not corrupt the stream" "PRINT_OK=True"       "$out"
assert_contains "its output is captured into the result"      "PRINT_CAPTURED=True" "$out"
assert_contains "the trailing expression is still the value"  "PRINT_VALUE=7"       "$out"

# ── the cache key is a content address, across processes ────────────
#
# README: "Keys are pure content addresses: they must not vary between
# processes, which is why function digests walk nested code objects instead of
# repr-ing them." Two pristine interpreters, different hash seeds, nothing warm
# carried between them — this is the only place in the repo where that sentence
# can actually be tested.
#
# Two cells, because the claim has two halves that fail for different reasons. A
# cell reading a closure keys on the code fingerprint, which must be address-free
# or it moves every process. A cell reading a *set* keys on a digest that pickle
# would build in iteration order, which follows the hash seed for str members —
# so a pickled set moves between processes even though its content did not.
key_of() {
	RUN_FLAGS="-v $STAGED:/pkg:ro -e PYTHONHASHSEED=$1" in_image '
		mkdir -p /tmp/pkg && cp -r /pkg/py /tmp/pkg/ || { echo "COPY_FAILED"; exit 1; }
		cd /tmp/pkg && python3 -c "
import sys
sys.path.insert(0, \"py\")
from kernel import Notebook

nb = Notebook()
nb.add(\"def make(n):\n    def inner(x):\n        return x * n\n    return inner\nadder = make(3)\")
closure_cell, _ = nb.add(\"total = adder(14)\")
print(\"CLOSURE_KEY=\" + nb._key(closure_cell))
print(\"TOTAL=\" + str(nb.ns.get(\"total\")))

nb.add(\"tags = {\\\"alpha\\\", \\\"beta\\\", \\\"gamma\\\", \\\"delta\\\", \\\"epsilon\\\"}\")
set_cell, _ = nb.add(\"tag_count = len(tags)\")
print(\"SET_KEY=\" + nb._key(set_cell))
print(\"COUNT=\" + str(nb.ns.get(\"tag_count\")))
"
	'
}

first="$(key_of 1)"
second="$(key_of 4242)"

assert_contains "the closure cell actually computed" "TOTAL=42" "$first"
assert_contains "the set cell actually computed"     "COUNT=5"  "$first"

for label in CLOSURE SET; do
	key1="$(printf '%s\n' "$first" | sed -n "s/^${label}_KEY=//p")"
	key2="$(printf '%s\n' "$second" | sed -n "s/^${label}_KEY=//p")"
	case "$label" in
	CLOSURE) what="a cell reading a closure" ;;
	SET) what="a cell reading a set" ;;
	esac
	if [ -n "$key1" ] && [ "$key1" = "$key2" ]; then
		ok "$what keys identically in two fresh processes ($key1)"
	else
		fail "$what keys identically in two fresh processes" \
			"PYTHONHASHSEED=1    -> ${key1:-none reported}" \
			"PYTHONHASHSEED=4242 -> ${key2:-none reported}"
	fi
done

summary
