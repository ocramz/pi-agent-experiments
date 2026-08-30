"""What interpreter this is, and what is installed in it.

The answer to "which python am I, and what is in me" has to come from the
running child rather than from the client's resolution rules: `resolvePython`
falls back to the base interpreter — or to a bare `python3` — when a venv
build fails, so what the client *planned* and what actually runs can differ,
and only this process knows which.

The package list is read with `importlib.metadata` rather than shelled out
to pip. Three reasons, in order of how much they hurt:

- a uv-built venv has no pip in it at all, and `_pip` in `protocol.py`
  bootstraps one with `ensurepip` — which would *mutate the venv* as a side
  effect of a read-only question;
- `uv export` is a different question, about a uv project's lockfile; the
  venvs this extension builds have no `pyproject.toml` anywhere near them;
- a subprocess would cost the kernel its stdlib-only property.

`uv pip freeze` is still worth having, because it renders editable and VCS
installs as the references they are instead of as a plain version — but it
is run by the *client*, which already shells out to uv to build venvs. Here
there is nothing but the standard library.

The same enumeration, hashed rather than listed, is pi-incremental-py's
`env_digest`; there it is a cache key, here it is the lock itself.
"""

from __future__ import annotations

import importlib.metadata
import sys

__all__ = ["distributions", "environment"]


def distributions() -> list[str]:
    """Every installed distribution as `Name==version`, sorted.

    Sorted so that two calls on an unchanged environment are byte-identical
    and a stored lock diffs cleanly. A distribution whose metadata carries
    no `Name` is skipped rather than raising: a half-written `.dist-info`
    left by an interrupted install is a thing that happens, and it is not a
    reason for the whole report to fail.
    """
    return sorted(
        f"{dist.metadata['Name']}=={dist.version}"
        for dist in importlib.metadata.distributions()
        if dist.metadata["Name"]
    )


def environment(packages: bool = True) -> dict:
    """The interpreter this kernel is, and optionally what is installed.

    `prefix` and `base_prefix` are both reported because their being
    different is the definition of "inside a venv" — which is the one
    property a caller storing this as an `env.lock` most needs to be able
    to check for itself.
    """
    info = {
        "executable": sys.executable,
        "version": ".".join(str(part) for part in sys.version_info[:3]),
        "implementation": sys.implementation.name,
        "prefix": sys.prefix,
        "base_prefix": sys.base_prefix,
    }
    if packages:
        info["packages"] = distributions()
        info["producer"] = "importlib.metadata"
    return info
