"""The kernel's tool surface: a JSON-lines protocol over stdin/stdout.

One JSON object per line in, one per line out, so a TypeScript agent (Pi,
say) can drive a long-lived Python namespace as a subprocess. Cell
stdout/stderr is captured into each Output's `stdout` field, so the wire on
real stdout is never corrupted by prints.

`install` lives here rather than on the notebook: pip is a tool acting on a
kernel, not part of the kernel. Unlike pi-incremental-py's, it invalidates
nothing — there is no cache here to go stale — but it still reports which
of the installed packages were already imported, because those keep their
old code until the namespace is restarted.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import os
import re
import subprocess
import sys
from dataclasses import asdict

from nbkernel import CellNotFound, Notebook, NotebookError, Output

__all__ = ["bootstrap_path", "handle", "install", "serve"]

# PEP 668 marks Debian/Ubuntu interpreters as externally managed; inside a
# venv the flag is neither needed nor always accepted.
_SYSTEM_FLAGS = [] if sys.prefix != sys.base_prefix else ["--break-system-packages"]
PIP_FLAGS = ["-q", *_SYSTEM_FLAGS]


def _pip(*args: str) -> subprocess.CompletedProcess:
    """Run pip, bootstrapping it first for pip-less (uv-built) venvs."""
    if importlib.util.find_spec("pip") is None:
        subprocess.run(
            [sys.executable, "-m", "ensurepip", "--upgrade"], capture_output=True
        )
    return subprocess.run(
        [sys.executable, "-m", "pip", *args],
        capture_output=True,
        text=True,
        check=False,
    )


# A requirement's project name is the leading run before any extras, version
# specifier or environment marker: `pandas[all]>=2 ; python_version<"3.13"`
# → `pandas`. A direct reference (`pandas @ https://…`) puts the name first too.
_PROJECT_NAME = re.compile(r"[A-Za-z0-9._-]+")


def _import_name(spec: str) -> str:
    """The module `spec` will most likely be imported as.

    Best effort by construction: a distribution whose import name differs from
    its project name (scikit-learn → sklearn) is not knowable from the
    specifier, so `restart_required` under-reports rather than lying.
    """
    found = _PROJECT_NAME.match(spec.strip())
    return (found.group(0) if found else spec).replace("-", "_")


def install(nb: Notebook, *packages: str, upgrade: bool = False) -> dict:
    """Install into the kernel's own interpreter."""
    proc = _pip("install", *PIP_FLAGS, *(["-U"] if upgrade else []), *packages)
    if proc.returncode:
        return {"ok": False, "error": proc.stderr.strip()[-400:]}

    # Without this the import system may serve a cached directory listing
    # and claim the package still isn't there.
    importlib.invalidate_caches()

    # Already-imported modules keep their old code: `import x` is a
    # sys.modules hit, and reload() is unsound for C extensions.
    loaded = sorted({_import_name(p) for p in packages} & set(sys.modules))
    return _response(nb, [], installed=list(packages), restart_required=loaded)


# -------------------------------------------------------------- protocol

EXPECTED_ERRORS = (
    NotebookError,
    CellNotFound,
    ValueError,
    TypeError,
    OSError,
)


def _need(req: dict, key: str):
    """A required argument, or an error that names it.

    `req[key]` would do the same job, but `KeyError: 'src'` is a poor thing
    to hand an agent, and putting KeyError in EXPECTED_ERRORS to catch it
    would also swallow every genuine one from inside the kernel — where it
    is a bug and belongs in the `internal` arm.
    """
    if key not in req:
        raise NotebookError(f"missing required argument {key!r}")
    return req[key]


def _response(nb: Notebook, outputs: list[Output], **extra) -> dict:
    """Every mutating op answers with the same three hint lists.

    They are on every response rather than behind an `inspect` call because
    the whole point of them is to be seen without being asked for: an agent
    that has to spend a tool call to discover it left four cells stale will
    not spend it.
    """
    return {
        "ok": True,
        "results": [asdict(o) for o in outputs],
        # How many cells there are, not which — the client autosaves a
        # checkpoint after every mutation and needs to know it is not about
        # to write an empty file over a good one.
        "cells": len(nb.cells),
        "stale": nb.stale(),
        "unrun": nb.unrun(),
        "failing": nb.failing(),
        "globals": nb.globals(),
        **extra,
    }


def handle(nb: Notebook, req: dict) -> dict:
    """One tool call in, one JSON-serialisable result out."""
    try:
        match req.get("tool"):
            case "add_cell":
                cell = nb.add(
                    _need(req, "src"),
                    after=req.get("after"),
                    kind=req.get("kind", "code"),
                )
                outputs = nb.run_cell(cell.id) if req.get("run", True) else []
                return _response(nb, outputs, id=cell.id)
            case "set_cell":
                cell = nb.set(
                    _need(req, "id"),
                    src=req.get("src"),
                    kind=req.get("kind"),
                )
                outputs = nb.run_cell(cell.id) if req.get("run", True) else []
                return _response(nb, outputs, id=cell.id)
            case "delete_cell":
                nb.delete(_need(req, "id"))
                return _response(nb, [])
            case "move_cell":
                cell = nb.move(_need(req, "id"), req.get("after"))
                return _response(nb, [], id=cell.id)
            case "run_cell":
                return _response(nb, nb.run_cell(_need(req, "id")))
            case "run_all":
                return _response(nb, nb.run_all(restart=req.get("restart", True)))
            case "run_above":
                return _response(nb, nb.run_above(_need(req, "id")))
            case "run_below":
                return _response(nb, nb.run_below(_need(req, "id")))
            case "restart":
                nb.restart()
                return _response(nb, [])
            case "inspect":
                return {"ok": True, **nb.describe(), **_hints(nb)}
            case "read":
                return {"ok": True, "cells": nb.read(req.get("id"))}
            case "eval":
                output = asdict(nb.eval_src(_need(req, "src")))
                return {"ok": output["status"] != "error", **output}
            case "save":
                saved = nb.save(
                    _need(req, "path"),
                    overwrite=req.get("overwrite", False),
                    remember=req.get("remember", True),
                    notebook=req.get("notebook"),
                )
                return _response(nb, [], saved=saved)
            case "load":
                loaded = nb.load(_need(req, "path"))
                outputs = nb.run_all() if req.get("run", False) else []
                return _response(nb, outputs, loaded=loaded)
            case "install":
                packages = _need(req, "packages")
                return install(nb, *packages, upgrade=req.get("upgrade", False))
            case other:
                return {"ok": False, "error": f"unknown tool {other!r}"}
    except EXPECTED_ERRORS as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    except Exception as exc:  # never kill serve mid-line
        return {"ok": False, "internal": True, "error": f"{type(exc).__name__}: {exc}"}


def _hints(nb: Notebook) -> dict:
    return {
        "stale": nb.stale(),
        "unrun": nb.unrun(),
        "failing": nb.failing(),
        "globals": nb.globals(),
    }


def serve(stdin=sys.stdin, stdout=sys.stdout, nb: Notebook | None = None) -> None:
    if nb is None:
        nb = Notebook()
    for line in stdin:
        if not line.strip():
            continue
        print(json.dumps(handle(nb, json.loads(line))), file=stdout, flush=True)


def bootstrap_path(cwd: str | None = None) -> None:
    """Make the working directory importable, as ipykernel does.

    The kernel is spawned as `python <pkg>/py/protocol.py`, and for a script
    path CPython puts the *script's* directory on sys.path[0] — `''` is only
    prepended for -c, -m and interactive mode. So without this a project's
    own modules are the one thing a notebook sitting in that project cannot
    import, which makes "write a helper, use it from a cell" fail.

    Index 0, matching Jupyter, and with Jupyter's consequence: a project file
    named `io.py` shadows the stdlib one. That is the user's own directory
    behaving the way Python says directories on the path behave.

    Called from `__main__` rather than from serve(): the tests drive serve()
    in-process, where mutating sys.path would leak into the test runner.
    """
    entry = os.getcwd() if cwd is None else cwd
    if entry not in sys.path:
        sys.path.insert(0, entry)


if __name__ == "__main__":  # `--serve` is accepted for compatibility
    bootstrap_path()
    serve()
