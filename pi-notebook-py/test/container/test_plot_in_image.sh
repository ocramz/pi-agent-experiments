#!/usr/bin/env bash
# Real matplotlib, end to end: install it, draw with it, get a PNG back.
#
# test-py/test_display.py drives a *fake* pyplot, deliberately — matplotlib is
# not a dependency of this kernel and must not become one just to test it. What
# the fake cannot prove is that the four calls we make (`get_fignums`, `figure`,
# `savefig`, `close`) are the real API, or that MPLBACKEND=Agg is enough to keep
# a headless import from reaching for a display. Nothing else in the repo covers
# the package's headline feature, so it is covered here or nowhere.
#
# Needs the network (PyPI) and pulls a large wheel set, so it runs last: an
# external index is the flakiest thing this tier depends on, and this is the
# slowest suite in it.
set -uo pipefail

export IMAGE="${PY_TEST_IMAGE:?PY_TEST_IMAGE must be set — see shared/versions.env}"
source "$(dirname "$0")/../../../shared/test/container/lib.sh"

# A venv build plus a PyPI round trip for matplotlib and numpy. Bounded for the
# same reason every live pi call is: an unbounded network step is one bad mirror
# away from wedging CI.
PLOT_TIMEOUT="${PLOT_TIMEOUT:-420}"

PKG="$(cd "$(dirname "$0")/../.." && pwd)"
STAGED="$(stage_pkg "$PKG")" || {
	echo "could not stage the package for the image user" >&2
	exit 1
}
trap 'rm -rf "$STAGED"' EXIT

out="$(RUN_FLAGS="-v $STAGED:/pkg:ro -e PLOT_TIMEOUT=$PLOT_TIMEOUT" in_image '
	mkdir -p /tmp/pkg && cp -r /pkg/src /pkg/py /tmp/pkg/ || { echo "COPY_FAILED"; exit 1; }
	mkdir -p /tmp/proj
	echo "USER_ID=$(id -u)"
	echo "PRISTINE=$(ls -a /tmp/proj | grep -c pi)"

	cat > /tmp/plot.mjs <<"MJS"
// NB: this heredoc sits inside a single-quoted bash string, so it must not
// contain a single quote anywhere — one would close that string and hand the
// rest of the script to the shell in pieces. Double quotes, escaped where they
// need to survive into Python.
import { Kernel } from "/tmp/pkg/src/kernel.ts";

const kernel = new Kernel(undefined, "/tmp/proj");

// The spawn sets MPLBACKEND itself. Without it, importing pyplot on a machine
// with a display picks an interactive backend and blocks on a GUI event loop.
const backend = await kernel.call({
	tool: "eval",
	src: "__import__(\"os\").environ[\"MPLBACKEND\"]",
});
console.log("BACKEND=" + backend.value);
console.log("BACKEND_ERROR=" + backend.error);

// A cell that imports something genuinely absent from a fresh venv.
const before = await kernel.call({ tool: "add_cell", src: "import matplotlib.pyplot as plt" });
console.log("BEFORE_STATUS=" + before.results[0].status);

const installed = await kernel.call({ tool: "install", packages: ["matplotlib"] });
console.log("INSTALL_OK=" + installed.ok);
console.log("INSTALL_ERROR=" + installed.error);

// Re-run the import now that it can succeed; nothing re-runs on its own here.
const imported = await kernel.call({ tool: "run_cell", id: before.id });
console.log("IMPORT_STATUS=" + imported.results[0].status);

const drew = await kernel.call({
	tool: "add_cell",
	src: "plt.figure()\nplt.plot([0, 1, 2], [2, 1, 0])\n123456",
});
const images = drew.results[0].images ?? [];
console.log("IMAGES=" + images.length);
console.log("VALUE=" + drew.results[0].value);
console.log("MIME=" + (images[0] ? images[0].mime : "none"));
if (images[0]) {
	const bytes = Buffer.from(images[0].b64, "base64");
	// The PNG signature. A base64 string that decodes to anything else means
	// we shipped the model something it cannot look at.
	console.log("PNG_MAGIC=" + (bytes.subarray(0, 4).toString("hex") === "89504e47"));
	console.log("PNG_BYTES=" + (bytes.length > 1000));
}

// Figures are consumed on capture, the way the inline backend consumes them.
// Left open, every subsequent cell in the notebook would redraw all of them.
const leftover = await kernel.call({ tool: "eval", src: "len(plt.get_fignums())" });
console.log("FIGS_AFTER=" + leftover.value);

const next = await kernel.call({ tool: "add_cell", src: "1 + 1" });
console.log("NEXT_IMAGES=" + (next.results[0].images ?? []).length);

// Where the install actually landed. Asked of the running kernel rather than
// of a path this script built up, so it is the interpreter that answers.
const prefix = await kernel.call({ tool: "eval", src: "import sys; sys.prefix" });
// A display value is a repr, so the path arrives quoted. charCode 39 rather
// than the character: this heredoc lives inside a single-quoted bash string.
console.log("SYS_PREFIX=" + String(prefix.value).replaceAll(String.fromCharCode(39), ""));
console.log("INTERPRETER=" + kernel.interpreter);
kernel.kill();
MJS

	timeout "$PLOT_TIMEOUT" node /tmp/plot.mjs
	case $? in 124 | 137 | 143) echo "TIMED_OUT=yes" ;; esac

	echo "VENVS_IN_PROJECT=$(find /tmp/proj -name pyvenv.cfg | wc -l | tr -d " ")"
')"

assert_not_contains "the package is readable by the image user" "COPY_FAILED"   "$out"
assert_contains     "runs as the unprivileged image user"       "USER_ID=65532" "$out"
assert_contains     "the project starts with no .pi"            "PRISTINE=0"    "$out"
assert_not_contains "the install finished inside its budget"    "TIMED_OUT=yes" "$out"

assert_contains "the kernel forces a headless backend"     "BACKEND='Agg'" "$out"
assert_contains "a venv was created from scratch"          "INTERPRETER=/tmp/.pi/notebook-py/venvs/" "$out"
# Placement is test_venv_isolation_in_image.sh's subject; this is the cheap
# restatement, so a regression shows up here too rather than only there.
assert_contains "and not inside the project"               "VENVS_IN_PROJECT=0" "$out"

# The control: the import must genuinely fail first, or "it worked after the
# install" proves nothing about the install.
assert_contains "the import fails before the install" "BEFORE_STATUS=error" "$out"
assert_contains "the install succeeded"               "INSTALL_OK=true"     "$out"
assert_contains "and the import then works"           "IMPORT_STATUS=ok"    "$out"
assert_contains "into the notebook's own venv"        "SYS_PREFIX=/tmp/.pi/notebook-py/venvs/" "$out"

assert_contains "a plotting cell returns one image"   "IMAGES=1"           "$out"
assert_contains "as a PNG"                            "MIME=image/png"     "$out"
assert_contains "that really is a PNG"                "PNG_MAGIC=true"     "$out"
assert_contains "and is not a stub"                   "PNG_BYTES=true"     "$out"
assert_contains "the cell keeps its own display value" "VALUE=123456"      "$out"

assert_contains "figures are consumed on capture"     "FIGS_AFTER=0"       "$out"
assert_contains "so the next cell attaches nothing"   "NEXT_IMAGES=0"      "$out"

summary
