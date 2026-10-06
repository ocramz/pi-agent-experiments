# Installing Harbor's ATIF validator inside PY_TEST_IMAGE. Source this.
#
# Both pins come from shared/versions.env via run-suites.sh. `--no-deps` is
# deliberate: the validator imports only pydantic, and Harbor's full dependency
# tree is minutes of install that would test nothing. A venv under /tmp because
# that is the only writable path the image user has.

: "${HARBOR_VERSION:?HARBOR_VERSION must be set — see shared/versions.env}"
: "${PYDANTIC_VERSION:?PYDANTIC_VERSION must be set — see shared/versions.env}"

# Bounded like every network step here: one bad mirror must not wedge CI.
INSTALL_TIMEOUT="${INSTALL_TIMEOUT:-240}"

HARBOR_FLAGS="-e HARBOR_VERSION=$HARBOR_VERSION -e PYDANTIC_VERSION=$PYDANTIC_VERSION -e INSTALL_TIMEOUT=$INSTALL_TIMEOUT"

# Splices into an in_image script; prints HARBOR=<version> or INSTALL_FAILED.
# shellcheck disable=SC2016  # expanded inside the container, not here
INSTALL_HARBOR='
	timeout "$INSTALL_TIMEOUT" sh -c "
		python3 -m venv /tmp/hv &&
		/tmp/hv/bin/python -m pip install -q --disable-pip-version-check pydantic==$PYDANTIC_VERSION &&
		/tmp/hv/bin/python -m pip install -q --disable-pip-version-check --no-deps harbor==$HARBOR_VERSION
	" > /tmp/pip.log 2>&1 || { echo INSTALL_FAILED; tail -5 /tmp/pip.log; exit 1; }
	/tmp/hv/bin/python -m pip show harbor 2>/dev/null | sed -n "s/^Version: /HARBOR=/p"
'
