#!/usr/bin/env bash
# Per-notebook environments, in the image userland.
#
# Four things this proves that no host tier can. The host has a warm ~/.pi, a
# uv on PATH, a writable HOME and a developer's PATH; here there is an
# unprivileged uid, HOME forced to /tmp, no uv, and nothing pre-built.
#
#   - a venv can be bootstrapped at all as uid 65532, which the whole
#     per-notebook design now rests on;
#   - nothing environment-shaped lands in the working tree, so `git add -A`
#     cannot sweep a venv into a commit. This is the version-control guarantee
#     as a test rather than as a paragraph in the README;
#   - two notebooks really do get two interpreters — a package installed into
#     one is absent from the other;
#   - a respawn reuses the venv instead of rebuilding it, which is the property
#     the container's named volume exists to preserve.
#
# Everything here is offline. The install case uses a wheel built in the image
# rather than anything from PyPI: a network dependency in this tier would be a
# flake, and the code path through `install` in py/protocol.py is the same
# either way.
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
	cp -r /pkg /tmp/pkg || { echo "COPY_FAILED"; exit 1; }

	# A project that is a real repository, so the question "would this be
	# committed" has a real answer rather than a simulated one.
	mkdir -p /tmp/proj && cd /tmp/proj || exit 1
	git init -q . 2>/dev/null || { echo "GIT_INIT_FAILED"; exit 1; }
	git config user.email t@example.com && git config user.name test

	# The offline package: a hand-built wheel needs no build backend and no
	# index, so `pip install` reaches the same code with no network at all.
	python3 - <<"PY"
import base64, hashlib, zipfile
name, version = "nbprobe", "1.0"
dist = f"{name}-{version}.dist-info"
files = {
    f"{name}.py": "MARKER = \"installed-in-a\"\n",
    f"{dist}/METADATA": f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n\n",
    f"{dist}/WHEEL": "Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
}
record = []
for path, body in files.items():
    digest = base64.urlsafe_b64encode(hashlib.sha256(body.encode()).digest()).rstrip(b"=").decode()
    record.append(f"{path},sha256={digest},{len(body)}")
record.append(f"{dist}/RECORD,,")
files[f"{dist}/RECORD"] = "\n".join(record) + "\n"
with zipfile.ZipFile(f"/tmp/{name}-{version}-py3-none-any.whl", "w") as z:
    for path, body in files.items():
        z.writestr(path, body)
PY

	cd /tmp/pkg && node /tmp/pkg/test/container/drive-venvs.ts 2>&1
	status=$?

	# Asked of git itself, after the driver has checkpointed both notebooks.
	cd /tmp/proj
	echo "GIT_STATUS_BEGIN"
	git status --porcelain
	echo "GIT_STATUS_END"
	echo "PYVENV_CFG_IN_TREE=$(find /tmp/proj -name pyvenv.cfg | wc -l | tr -d " ")"
	exit $status
')"

assert_not_contains "the package is readable by the image user" "COPY_FAILED"      "$out"
assert_not_contains "the fixture project is a git repository"   "GIT_INIT_FAILED"  "$out"
assert_contains     "runs as the unprivileged image user"       "USER_ID=65532"    "$out"
assert_contains     "HOME is redirected to the writable path"   "HOME_IS=/tmp"     "$out"

# 1. A venv at all, built here rather than inherited from a warm developer HOME.
assert_contains "a venv is bootstrapped as the image user" "VENV_BUILT=yes" "$out"
assert_contains "the venv is under HOME, not under the project" "VENV_UNDER_HOME=yes" "$out"

# 2. The version-control guarantee. `git status` is the whole assertion: the
#    checkpoints are there to be committed and nothing else is.
tracked="$(printf '%s\n' "$out" | sed -n '/^GIT_STATUS_BEGIN$/,/^GIT_STATUS_END$/p' |
	sed '1d;$d' | sed 's/^...//' | sort)"
expected=".pi/"
if [ "$tracked" = "$expected" ]; then
	ok "the only thing git sees is the .pi checkpoints"
else
	fail "the only thing git sees is the .pi checkpoints" \
		"expected: $expected" "actual: ${tracked:-nothing}"
fi
assert_contains "the checkpoints are the files inside it" "CHECKPOINTS=a.py,b.py" "$out"
assert_contains "no venv was built inside the working tree" "PYVENV_CFG_IN_TREE=0" "$out"

# 3. Two notebooks, two environments.
assert_contains "a package installed in one notebook is importable there" "IMPORT_IN_A=ok" "$out"
assert_contains "and absent from the other"        "IMPORT_IN_B=ModuleNotFoundError" "$out"
assert_contains "the two notebooks ran different interpreters" "SAME_INTERPRETER=no" "$out"

# 4. The property the named volume preserves: a venv is built once.
assert_contains "a respawn reuses the venv rather than rebuilding it" "VENV_REUSED=yes" "$out"

summary
