#!/usr/bin/env bash
# The JSON-lines protocol, spoken by a foreign process.
#
# No node and no pi here: this drives py/protocol.py over a pipe exactly as
# anything else would. The TypeScript tiers cannot check this — they only ever
# see the protocol through src/kernel.ts, which is the one client guaranteed to
# agree with it.
#
# Every assertion keys on the wire, and each headline claim is paired with a
# control: "stale" is only evidence of tracking if the same setup reports
# nothing stale when the notebook is genuinely in step.
set -uo pipefail

export IMAGE="${PY_TEST_IMAGE:?PY_TEST_IMAGE must be set — see shared/versions.env}"
source "$(dirname "$0")/../../../shared/test/container/lib.sh"

PKG="$(cd "$(dirname "$0")/../.." && pwd)"
STAGED="$(stage_pkg "$PKG")" || {
	echo "could not stage the package for the image user" >&2
	exit 1
}
trap 'rm -rf "$STAGED"' EXIT

out="$(RUN_FLAGS="-v $STAGED:/pkg:ro" in_image '
	mkdir -p /tmp/pkg && cp -r /pkg/py /tmp/pkg/ || { echo "COPY_FAILED"; exit 1; }
	cd /tmp/pkg
	echo "USER_ID=$(id -u)"

	cat > /tmp/drive.py <<"PY"
import json, os, subprocess, sys

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

# ── a cell runs and reports its display value ──────────────────
first = call({"tool": "add_cell", "src": "a = 2"})
print("FIRST_ID=" + str(first["id"]))
second = call({"tool": "add_cell", "src": "b = a * 3"})
third = call({"tool": "add_cell", "src": "b + 1"})
print("VALUE=" + str(third["results"][0]["value"]))
print("IN_STEP_STALE=" + json.dumps(third["stale"]))

# ── a noisy cell does not desynchronise the wire ────────────────
noisy = call({"tool": "add_cell", "src": "for i in range(300): print(i)"})
print("NOISY_OK=" + str(noisy["ok"]))
print("NOISY_LINES=" + str(len(noisy["results"][0]["stdout"].splitlines())))
after_noise = call({"tool": "eval", "src": "\"wire-intact\""})
print("AFTER_NOISE=" + str(after_noise["value"]))

# ── editing reports exactly what it left behind ─────────────────
edited = call({"tool": "set_cell", "id": first["id"], "src": "a = 5", "run": False})
print("STALE=" + json.dumps(edited["stale"]))
print("UNRUN=" + json.dumps(edited["unrun"]))

replayed = call({"tool": "run_all"})
print("REPLAY_STALE=" + json.dumps(replayed["stale"]))
print("REPLAY_UNRUN=" + json.dumps(replayed["unrun"]))
print("REPLAY_VALUE=" + str(replayed["results"][2]["value"]))

# ── a failure is a result, and the kernel survives it ───────────
broken = call({"tool": "add_cell", "src": "1 / 0"})
print("BROKEN_OK=" + str(broken["ok"]))
print("BROKEN_STATUS=" + str(broken["results"][0]["status"]))
print("BROKEN_TRACEBACK=" + ("yes" if "<cell " in (broken["results"][0]["traceback"] or "") else "no"))
print("FAILING=" + json.dumps(broken["failing"]))
print("ALIVE=" + str(call({"tool": "eval", "src": "1 + 1"})["value"]))

# ── an unknown tool is answered, not fatal ──────────────────────
print("UNKNOWN_OK=" + str(call({"tool": "frobnicate"})["ok"]))
print("STILL_ALIVE=" + str(call({"tool": "eval", "src": "2 + 2"})["value"]))

# ── persistence, over the wire ──────────────────────────────────
path = "/tmp/nb-wire.py"
saved = call({"tool": "save", "path": path})
print("SAVED_OK=" + str(saved["ok"]))
print("ON_DISK=" + ("yes" if os.path.exists(path) else "no"))
with open(path) as fh:
    text = fh.read()
print("HAS_MARKER=" + ("yes" if "# %%" in text else "no"))
print("HAS_SOURCE=" + ("yes" if "b = a * 3" in text else "no"))
print("HAS_OUTPUT=" + ("yes" if "16" in text else "no"))

loaded = call({"tool": "load", "path": path})
print("LOAD_CELLS=" + str(loaded["loaded"]["cells"]))

# Saving over a file that is not a notebook is refused without the flag.
with open("/tmp/plain.py", "w") as fh:
    fh.write("def important():\n    return 1\n")
refused = call({"tool": "save", "path": "/tmp/plain.py"})
print("REFUSED_OK=" + str(refused["ok"]))
print("REFUSED_INTERNAL=" + str(refused.get("internal", False)))
with open("/tmp/plain.py") as fh:
    print("PLAIN_INTACT=" + ("yes" if "important" in fh.read() else "no"))

# ── the environment report, from a cold interpreter ─────────────
env = call({"tool": "env"})
print("ENV_IS_SELF=" + ("yes" if env["executable"] == sys.executable else "no"))
print("ENV_VERSION_SHAPE=" + ("yes" if env["version"].count(".") == 2 else "no"))
print("ENV_HAS_LOCK=" + ("yes" if isinstance(env["packages"], list) else "no"))
# A report is not a mutation: the three hint lists must not ride on it.
print("ENV_HINTLESS=" + ("yes" if "stale" not in env else "no"))
print("ENV_NO_LOCK=" + ("yes" if "packages" not in call({"tool": "env", "lock": False}) else "no"))
# Asked of the kernel, not of this driver: the lock must not have reached for
# pip to answer. A uv-built venv has none, and bootstrapping one with ensurepip
# would have changed the environment it was asked to describe. (No apostrophes
# anywhere in this file: the whole script is one single-quoted argument to
# `in_image`, and a lone quote silently reassembles the line into something else.)
probe = "__import__(\"sys\").modules.get(\"pip\") is None"
print("ENV_NO_PIP_IMPORT=" + ("yes" if call({"tool": "eval", "src": probe})["value"] == "True" else "no"))

# ── the digest, against the bytes save actually wrote ───────────
import hashlib

digest_path = "/tmp/nb-digest.py"
call({"tool": "save", "path": digest_path, "notebook": "wire", "overwrite": True})
with open(digest_path, "rb") as fh:
    on_disk = hashlib.sha256(fh.read()).hexdigest()
reported = call({"tool": "digest", "notebook": "wire"})
print("DIGEST_MATCHES=" + ("yes" if reported["sha256"] == on_disk else "no"))
# The control: a digest that matched everything would prove nothing.
print("DIGEST_MOVES=" + ("yes" if call({"tool": "digest"})["sha256"] != on_disk else "no"))
PY

	python3 /tmp/drive.py
')"

assert_not_contains "the package is readable by the image user" "COPY_FAILED"  "$out"
assert_contains     "runs as the unprivileged image user"       "USER_ID=65532" "$out"

assert_contains "a cell runs and reports its display value" "VALUE=7"           "$out"
assert_contains "a notebook run in order reports nothing stale" "IN_STEP_STALE=[]" "$out"

# The premise of the whole protocol: cell stdout is captured, not written to
# the stream the responses travel on.
assert_contains "a noisy cell's stdout is captured"      "NOISY_LINES=300"        "$out"
assert_contains "and the wire is still synchronised"     "AFTER_NOISE='wire-intact'" "$out"

# Both halves. "everything is stale" would satisfy a test that only looked at
# the cells below the edit.
assert_contains "an edit stales exactly the cells below it" 'STALE=["c2", "c3", "c4"]' "$out"
assert_contains "and leaves the edited cell unrun"          'UNRUN=["c1"]'             "$out"
assert_contains "a full replay clears the staleness report" "REPLAY_STALE=[]"          "$out"
assert_contains "and leaves nothing unrun"                  "REPLAY_UNRUN=[]"          "$out"
assert_contains "the replay picks up the edit"              "REPLAY_VALUE=16"          "$out"

assert_contains "a failing cell is a result, not a protocol error" "BROKEN_OK=True"      "$out"
assert_contains "the failure is reported as one"                   "BROKEN_STATUS=error" "$out"
assert_contains "the traceback names the cell it came from"        "BROKEN_TRACEBACK=yes" "$out"
assert_contains "and the cell is listed as failing"                'FAILING=["c5"]'      "$out"
assert_contains "the kernel serves the next request"               "ALIVE=2"             "$out"

assert_contains "an unknown tool is answered"        "UNKNOWN_OK=False" "$out"
assert_contains "without killing the serve loop"     "STILL_ALIVE=4"    "$out"

assert_contains "save writes a file"                     "ON_DISK=yes"    "$out"
assert_contains "in percent format"                      "HAS_MARKER=yes" "$out"
assert_contains "carrying the source"                    "HAS_SOURCE=yes" "$out"
# The documented cost of the format, asserted rather than assumed: if outputs
# ever started being written, the README's promise about diffs would be a lie.
assert_contains "and deliberately not the outputs"       "HAS_OUTPUT=no"  "$out"
assert_contains "and it loads back"                      "LOAD_CELLS=5"   "$out"

assert_contains "saving over a plain .py is refused"     "REFUSED_OK=False"        "$out"
assert_contains "as an expected error, not an internal one" "REFUSED_INTERNAL=False" "$out"
assert_contains "and the file is left alone"             "PLAIN_INTACT=yes"        "$out"

# The environment report answers from the process that is running, which is the
# only thing that can: the client's resolution rules can name an interpreter a
# failed venv build left nothing running in.
assert_contains "env reports the running interpreter"  "ENV_IS_SELF=yes"       "$out"
assert_contains "with a full version number"           "ENV_VERSION_SHAPE=yes" "$out"
assert_contains "and a package list"                   "ENV_HAS_LOCK=yes"      "$out"
assert_contains "a report carries no staleness hints"  "ENV_HINTLESS=yes"      "$out"
assert_contains "the lock can be left out"             "ENV_NO_LOCK=yes"       "$out"
# The reason the lock is read from importlib.metadata rather than from pip.
assert_contains "and answering never reaches for pip"  "ENV_NO_PIP_IMPORT=yes" "$out"

assert_contains "the digest is of the bytes save writes" "DIGEST_MATCHES=yes" "$out"
assert_contains "and the notebook name is part of it"    "DIGEST_MOVES=yes"   "$out"

summary
