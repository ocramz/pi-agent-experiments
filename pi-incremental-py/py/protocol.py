"""The kernel's tool surface: a JSON-lines protocol over stdin/stdout.

One JSON object per line in, one per line out, so a TypeScript agent (Pi,
say) can drive a long-lived Python namespace as a subprocess. Cell
stdout/stderr is captured into each Result's `output` field, so the wire
on real stdout is never corrupted by prints.

`install` lives here rather than on the notebook: pip is a tool acting on
a kernel, not part of the kernel. What the kernel keeps is the *digest*
of the installed set (`Notebook.env`), because that digest is part of a
cell's cache key.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import subprocess
import sys
from dataclasses import asdict

from kernel import (
    CycleError,
    DuplicateNameError,
    Edit,
    MultipleDefinitionError,
    Notebook,
    Result,
    as_flag,
    env_digest,
)

__all__ = ["handle", "install", "serve"]

# PEP 668 marks Debian/Ubuntu interpreters as externally managed; inside a
# venv the flag is neither needed nor always accepted.
_SYSTEM_FLAGS = [] if sys.prefix != sys.base_prefix else ["--break-system-packages"]
PIP_FLAGS = ["-q", *_SYSTEM_FLAGS]


def _pip(*args: str, check: bool = False) -> subprocess.CompletedProcess:
    """Run pip, bootstrapping it first for pip-less (uv-built) venvs."""
    if importlib.util.find_spec("pip") is None:
        subprocess.run(
            [sys.executable, "-m", "ensurepip", "--upgrade"], capture_output=True
        )
    return subprocess.run(
        [sys.executable, "-m", "pip", *args],
        capture_output=True,
        text=True,
        check=check,
    )


def install(nb: Notebook, *packages: str, upgrade: bool = False) -> dict:
    """Install into the kernel's own interpreter and invalidate the cells
    that could have observed the old environment."""
    proc = _pip("install", *PIP_FLAGS, *(["-U"] if upgrade else []), *packages)
    if proc.returncode:
        return {"ok": False, "error": proc.stderr.strip()[-400:]}

    # Without this the import system may serve a cached directory listing
    # and claim the package still isn't there.
    importlib.invalidate_caches()

    before, nb.env = nb.env, env_digest(refresh=True)
    changed = nb.env != before
    if changed:
        for cid, cell in nb.cells.items():
            if cell.imports:
                nb.pending |= {cid} | nb.descendants(cid)

    # Already-imported modules keep their old code: `import x` is a
    # sys.modules hit, and reload() is unsound for C extensions.
    loaded = sorted(
        {p.split("==")[0].split("[")[0].replace("-", "_") for p in packages}
        & set(sys.modules)
    )
    # Through `_response` like every other mutating op: an install re-runs
    # cells, so it can leave the notebook failing or pending, and it moves
    # the globals it was called to fix. Reporting only `results` made the
    # caller spend a second `inspect` to find out what it had just done.
    return _response(nb, nb.run(), environment_changed=changed, restart_required=loaded)


# -------------------------------------------------------------- protocol

EXPECTED_ERRORS = (
    MultipleDefinitionError,
    DuplicateNameError,
    CycleError,
    SyntaxError,
    KeyError,
    ValueError,
)


def _result_json(nb: Notebook, r: Result, volatile: set[str]) -> dict:
    """A result, plus the two things about it the wire cannot otherwise carry.

    `stateful` is a property of the cell rather than of the run, but a
    consumer holding only results has no way to ask: a self-referential
    cell's successive values are a history (the accumulator advanced),
    where an ordinary cell's are stale copies of one truth. Anything
    deciding which of its recorded output is still current has to be able
    to tell those apart. A deleted cell has no cell left to ask.

    `volatile` is the same kind of fact, and it explains an otherwise
    baffling run: a cell that reports `ran` every single time, with
    nothing upstream of it moving, is not a bug. `effects` rides along
    because it names *why* — an empty tuple almost always, and the one
    audit event that demoted the cell when it is not.

    `reads` is deliberately dropped. It can be dozens of paths per cell,
    it does not change between runs, and `inspect` already reports it
    where a reader can look it up once instead of on every result.
    """
    payload = asdict(r)
    payload.pop("reads", None)
    return {
        **payload,
        "stateful": r.cell in nb.cells and nb.stateful(r.cell),
        "volatile": r.cell in volatile,
    }


def _response(nb: Notebook, results: list[Result], **extra) -> dict:
    volatile = nb.volatile()
    return {
        "ok": True,
        "results": [_result_json(nb, r, volatile) for r in results],
        "pending": sorted(nb.pending),
        "failing": nb.failing(),
        "globals": nb.globals_brief(),
        **extra,
    }


def handle(nb: Notebook, req: dict) -> dict:
    """One tool call in, one JSON-serialisable result out."""
    try:
        match req.get("tool"):
            case "add_cell":
                cid, results = nb.add(
                    req["src"],
                    name=req.get("name"),
                    run=req.get("run", True),
                    volatile=bool(as_flag(req.get("volatile"))),
                )
                return _response(nb, results, id=cid)
            case "set_cell":
                results = nb.set(
                    req["id"],
                    req["src"],
                    run=req.get("run", True),
                    volatile=as_flag(req.get("volatile")),
                )
                return _response(nb, results)
            case "delete_cell":
                results = nb.delete(req["id"], run=req.get("run", True))
                return _response(nb, results)
            case "rerun_cell":
                return _response(nb, nb.rerun(req["id"]))
            case "run_all":
                return _response(nb, nb.run_all(restart=req.get("restart", True)))
            case "apply_edits":
                edits = [Edit.from_json(e) for e in req["edits"]]
                results, created = nb.apply(edits, run=req.get("run", True))
                return _response(nb, results, created=created)
            case "plan_edits":
                edits = [Edit.from_json(e) for e in req["edits"]]
                return {"ok": True, "would_invalidate": sorted(nb.plan(edits))}
            case "inspect":
                return {"ok": True, **nb.describe()}
            case "eval":
                r = nb.eval_src(req["src"])
                payload = asdict(r)
                # No cell owns this, so there is nothing for observations
                # to key or demote. Dropping them keeps `/py` terse.
                payload.pop("reads", None)
                payload.pop("effects", None)
                return {"ok": r.status != "error", **payload}
            case "install":
                return install(nb, *req["packages"], upgrade=req.get("upgrade", False))
            case other:
                return {"ok": False, "error": f"unknown tool {other!r}"}
    except EXPECTED_ERRORS as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    except Exception as exc:  # never kill serve mid-line
        return {"ok": False, "internal": True, "error": f"{type(exc).__name__}: {exc}"}


def serve(stdin=sys.stdin, stdout=sys.stdout, nb: Notebook | None = None) -> None:
    if nb is None:
        nb = Notebook()
    for line in stdin:
        if not line.strip():
            continue
        print(json.dumps(handle(nb, json.loads(line))), file=stdout, flush=True)


if __name__ == "__main__":  # `--serve` is accepted for compatibility
    serve()
