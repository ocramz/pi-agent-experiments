#!/usr/bin/env bash
# py_install, end to end, in a project that has never been built before.
#
# This is the one suite that goes all the way through: node drives src/kernel.ts,
# which resolves an interpreter, builds .incremental/venv from scratch,
# bootstraps pip into it, installs a real package from PyPI, and then has to get
# the invalidation right. Every step of that is environment-shaped, and on a dev
# machine every step is pre-warmed — the venv exists, pip is there, the package
# is probably already in a cache.
#
# The claim under test is the specific one the README makes: an install
# invalidates exactly the cells that import, and their descendants. Which is why
# the non-importing cell matters as much as the importing one — "everything
# re-ran" would satisfy a test that only looked at the cell that changed.
#
# Needs the network (PyPI), but no API key. It runs last because an external
# index is the flakiest thing this tier depends on.
set -uo pipefail

export IMAGE="${PY_TEST_IMAGE:?PY_TEST_IMAGE must be set — see shared/versions.env}"
source "$(dirname "$0")/../../../shared/test/container/lib.sh"

# A venv build plus a PyPI round trip. Bounded for the same reason every live pi
# call is: an unbounded network step is one bad mirror away from wedging CI.
INSTALL_TIMEOUT="${INSTALL_TIMEOUT:-240}"

PKG="$(cd "$(dirname "$0")/../.." && pwd)"
STAGED="$(stage_pkg "$PKG")" || {
	echo "could not stage the package for the image user" >&2
	exit 1
}
trap 'rm -rf "$STAGED"' EXIT

out="$(RUN_FLAGS="-v $STAGED:/pkg:ro -e INSTALL_TIMEOUT=$INSTALL_TIMEOUT" in_image '
	mkdir -p /tmp/pkg && cp -r /pkg/src /pkg/py /tmp/pkg/ || { echo "COPY_FAILED"; exit 1; }
	mkdir -p /tmp/proj
	echo "USER_ID=$(id -u)"
	echo "PRISTINE=$(ls -a /tmp/proj | grep -c incremental)"

	cat > /tmp/install.mjs <<"MJS"
import { Kernel } from "/tmp/pkg/src/kernel.ts";

const kernel = new Kernel(undefined, "/tmp/proj");
const statuses = (resp) =>
	Object.fromEntries((resp.results ?? []).map((r) => [r.cell, r.status]));

// A cell with no import: nothing about it depends on the environment, so an
// install must leave it alone.
const plain = await kernel.call({ tool: "add_cell", src: "base = 6 * 7" });
console.log("PLAIN_OK=" + plain.ok);
const plainId = plain.id;

// A cell that imports something genuinely absent from a fresh venv.
const importer = await kernel.call({
	tool: "add_cell",
	src: "import cowsay\nhave_cowsay = True",
});
const importerId = importer.id;
console.log("IMPORT_STATUS=" + statuses(importer)[importerId]);
console.log("IMPORT_FAILING=" + importer.failing.includes(importerId));

const installed = await kernel.call({ tool: "install", packages: ["cowsay"] });
console.log("INSTALL_OK=" + installed.ok);
console.log("INSTALL_ERROR=" + installed.error);
console.log("ENV_CHANGED=" + installed.environment_changed);

const after = statuses(installed);
console.log("AFTER_IMPORTER=" + (after[importerId] ?? "absent"));
console.log("AFTER_PLAIN=" + (after[plainId] ?? "absent"));

// The install response itself, before anything asks the kernel a second
// question: it re-ran cells, so it reports the state that left behind.
console.log("INSTALL_GLOBAL=" + installed.globals.have_cowsay);
console.log("INSTALL_FAILING=" + JSON.stringify(installed.failing));
console.log("INSTALL_PENDING=" + JSON.stringify(installed.pending));

const state = await kernel.call({ tool: "inspect" });
console.log("HAVE_COWSAY=" + state.globals.have_cowsay);
console.log("BASE=" + state.globals.base);
console.log("STILL_FAILING=" + JSON.stringify(state.failing));
kernel.kill();
MJS

	timeout "$INSTALL_TIMEOUT" node /tmp/install.mjs
	case $? in 124 | 137 | 143) echo "TIMED_OUT=yes" ;; esac

	echo "VENV=$([ -x /tmp/proj/.incremental/venv/bin/python ] && echo yes || echo no)"
	echo "IGNORED=$(cat /tmp/proj/.incremental/.gitignore 2>/dev/null | tr "\n" " ")"
	echo "IN_VENV=$(/tmp/proj/.incremental/venv/bin/python -c "import cowsay, sys; print(sys.prefix)" 2>&1 | tail -1)"
')"

assert_not_contains "the package is readable by the image user" "COPY_FAILED"  "$out"
assert_contains     "runs as the unprivileged image user"       "USER_ID=65532" "$out"
assert_contains     "the project starts with no .incremental"   "PRISTINE=0"    "$out"
assert_not_contains "the install finished inside its budget"    "TIMED_OUT=yes" "$out"

# The venv is built from nothing, by an unprivileged uid, with HOME on /tmp.
assert_contains "a project venv was created from scratch" "VENV=yes"    "$out"
assert_contains "the venv is kept out of git"             "IGNORED=venv/ python-pin" "$out"

assert_contains "the plain cell ran"                  "PLAIN_OK=true"        "$out"
assert_contains "the importing cell fails first"      "IMPORT_STATUS=error"  "$out"
assert_contains "and is reported as failing"          "IMPORT_FAILING=true"  "$out"

assert_contains "the install succeeded"               "INSTALL_OK=true"      "$out"
assert_contains "the environment is reported changed" "ENV_CHANGED=true"     "$out"

# The two halves of the claim. The importing cell re-runs because the installed
# distribution set is one of its inputs; the plain cell must not, or the
# invalidation is just "rerun everything" wearing a dependency graph.
assert_contains     "the importing cell re-runs after the install" "AFTER_IMPORTER=ran" "$out"
assert_not_contains "the non-importing cell is left alone"         "AFTER_PLAIN=ran"    "$out"

# An install re-runs cells, so its own response carries the same pending/failing/
# globals tails every other mutating op returns. Without them the agent has to
# spend the `inspect` below just to see what the install it made had done.
assert_contains "the install reports the recomputed value" "INSTALL_GLOBAL=True"  "$out"
assert_contains "the install reports nothing left failing" "INSTALL_FAILING=[]"   "$out"
assert_contains "the install reports nothing left pending" "INSTALL_PENDING=[]"   "$out"

assert_contains "the import now succeeds"        "HAVE_COWSAY=True"  "$out"
assert_contains "the untouched value survived"   "BASE=42"           "$out"
assert_contains "nothing is left failing"        "STILL_FAILING=[]"  "$out"

# py_install must install into the kernel's own venv, never the interpreter that
# happens to be on PATH — that separation is the whole reason the tool exists
# instead of letting the agent shell out to pip.
assert_contains "the package landed in the project venv" "IN_VENV=/tmp/proj/.incremental/venv" "$out"

summary
