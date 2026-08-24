"""Expose the reactive kernel to a coding agent as a tiny tool surface.

Two additions over `reactive.py`:

1. Content-addressed caching. A cell's key is a hash of its source plus
   the value-digests of every global it reads — including its own defs,
   so a stateful cell (`x = x + 1`) keys on the previous version and
   honestly re-runs. Key unchanged -> skip. This gives *early cutoff*
   for free: if a re-run produces the same value, downstream keys don't
   move and nothing downstream re-runs.

2. A JSON-lines protocol over stdin/stdout, so a TypeScript agent (Pi,
   say) can drive a long-lived Python namespace as a subprocess. Cell
   stdout/stderr is captured into each Result's `output` field, so the
   wire on real stdout is never corrupted by prints.
"""

from __future__ import annotations

import hashlib
import json
import pickle
import sys
import time
import types
from dataclasses import asdict

from reactive import (
    CycleError,
    DuplicateNameError,
    MultipleDefinitionError,
    Notebook,
    Result,
)

# --------------------------------------------------------------- digests


def digest(obj: object) -> str | None:
    """Stable content digest, or None meaning 'assume always changed'."""
    if isinstance(obj, types.ModuleType):
        # Include the version: a bare name is blind to upgrades, so early
        # cutoff would stop propagating after `pip install -U`.
        try:
            import importlib.metadata as md

            version = md.version(obj.__name__.split(".")[0])
        except Exception:
            version = getattr(obj, "__version__", "?")
        return f"module:{obj.__name__}:{version}"
    if isinstance(obj, (types.FunctionType, types.LambdaType)):
        # Pickle would serialise a function *by name*, so an edited body
        # would hash identically. Hash the code object instead.
        code = obj.__code__
        return _hash(repr((code.co_code, code.co_consts, code.co_names)))
    try:
        return _hash(pickle.dumps(obj, protocol=4))
    except Exception:
        return None  # sockets, file handles, live models, ...


def _hash(data) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.blake2b(data, digest_size=12).hexdigest()


# --------------------------------------------------------------- kernel


class CachingNotebook(Notebook):
    def __init__(self, seed: int | None = None) -> None:
        super().__init__(seed=seed)
        self.keys: dict[str, str] = {}
        self._summaries: dict[str, str | None] = {}  # last value per cell

    def _snapshot_extra(self) -> object:
        return (dict(self.keys), dict(self._summaries))

    def _restore_extra(self, state: object) -> None:
        self.keys, self._summaries = state  # type: ignore[misc]

    def _key(self, cid: str) -> str:
        cell = self.cells[cid]
        # Self-refs resolve to the previous committed version in ns at
        # this point (pre-exec), so stateful cells key on their history.
        inputs = sorted(
            (name, digest(self.ns.get(name)))
            for name in cell.refs
            if name in self.provider
        )
        if any(d is None for _, d in inputs):
            return _hash(f"{time.time_ns()}")  # unhashable input: never cache
        return _hash(cell.src + repr(inputs))

    def run(self) -> list[Result]:
        if not self.pending:
            return []

        candidates: set[str] = set()
        for cid in self.pending:
            candidates |= {cid} | self.descendants(cid)
        candidates &= set(self.cells)

        results: list[Result] = []
        failed: set[str] = set()
        skip: set[str] = set()

        for cid in self.topo(candidates):
            if cid in skip:
                continue
            cell = self.cells[cid]
            key = self._key(cid)

            fresh = (
                key == self.keys.get(cid)
                and cell.error is None
                and all(n in self.ns for n in cell.defs)
            )
            if fresh:
                results.append(
                    Result(cid, "cached", 0.0, value=self._summaries.get(cid))
                )
                continue

            result = self._execute(cid)
            if result.status == "error":
                failed.add(cid)
                skip |= self.descendants(cid)
                self.keys.pop(cid, None)
                self._summaries.pop(cid, None)
            else:
                self.keys[cid] = key
                self._summaries[cid] = result.value
            results.append(result)

        self.pending = failed | skip
        return results

    def rerun(self, cid: str) -> list[Result]:
        self.keys.pop(cid, None)  # force: a matching key would short-circuit
        return super().rerun(cid)

    def run_all(self, restart: bool = True) -> list[Result]:
        if restart:
            self.keys.clear()
            self._summaries.clear()
        return super().run_all(restart=restart)


# -------------------------------------------------------------- protocol

EXPECTED_ERRORS = (
    MultipleDefinitionError,
    DuplicateNameError,
    CycleError,
    SyntaxError,
    KeyError,
    ValueError,
)


def _response(nb: CachingNotebook, results: list[Result], **extra) -> dict:
    return {
        "ok": True,
        "results": [asdict(r) for r in results],
        "pending": sorted(nb.pending),
        "failing": sorted(cid for cid, c in nb.cells.items() if c.error),
        "globals": nb.describe()["globals"],
        **extra,
    }


def handle(nb: CachingNotebook, req: dict) -> dict:
    """One tool call in, one JSON-serialisable result out."""
    try:
        match req.get("tool"):
            case "add_cell":
                cid, results = nb.add(
                    req["src"], name=req.get("name"), run=req.get("run", True)
                )
                return _response(nb, results, id=cid)
            case "set_cell":
                results = nb.set(req["id"], req["src"], run=req.get("run", True))
                return _response(nb, results)
            case "delete_cell":
                results = nb.delete(req["id"], run=req.get("run", True))
                return _response(nb, results)
            case "rerun_cell":
                return _response(nb, nb.rerun(req["id"]))
            case "run_all":
                return _response(nb, nb.run_all(restart=req.get("restart", True)))
            case "apply_edits":
                edits, created = _translate_edits(nb, req["edits"])
                results = nb.apply(edits, run=req.get("run", True))
                return _response(nb, results, created=created)
            case "plan_edits":
                edits, _ = _translate_edits(nb, req["edits"])
                return {"ok": True, "would_invalidate": sorted(nb.plan(edits))}
            case "inspect":
                return {"ok": True, **nb.describe()}
            case "eval":
                r = nb.eval_src(req["src"])
                return {"ok": r.status != "error", **asdict(r)}
            case "install":
                install = getattr(nb, "install", None)
                if install is None:
                    return {"ok": False, "error": "kernel has no install tool"}
                return install(*req["packages"], upgrade=req.get("upgrade", False))
            case other:
                return {"ok": False, "error": f"unknown tool {other!r}"}
    except EXPECTED_ERRORS as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    except Exception as exc:  # never kill serve mid-line
        return {"ok": False, "internal": True, "error": f"{type(exc).__name__}: {exc}"}


def _translate_edits(nb: CachingNotebook, raw: list) -> tuple[list[tuple], list[str]]:
    edits: list[tuple] = []
    created: list[str] = []
    for e in raw:
        match e:
            case {"op": "add", "src": src, **rest}:
                cid = nb._new_id()
                edits.append(("create", cid, src, rest.get("name")))
                created.append(cid)
            case {"op": "set", "id": cid, "src": src}:
                edits.append(("modify", cid, src))
            case {"op": "delete", "id": cid}:
                edits.append(("delete", cid))
            case _:
                raise ValueError(f"bad edit {e!r}")
    return edits, created


def serve(
    stdin=sys.stdin, stdout=sys.stdout, nb: CachingNotebook | None = None
) -> None:
    if nb is None:
        try:
            from env_kernel import EnvNotebook

            nb = EnvNotebook()
        except Exception:
            nb = CachingNotebook()
    for line in stdin:
        if not line.strip():
            continue
        print(json.dumps(handle(nb, json.loads(line))), file=stdout, flush=True)


# ------------------------------------------------------------------ demo


def _demo() -> None:
    nb = CachingNotebook(seed=3)

    def show(label, results):
        print(f"\n{label}")
        for r in results:
            mark = {"ran": "*", "cached": "-", "error": "!"}[r.status]
            print(
                f"  {mark} {r.cell} {r.status:7} {r.seconds * 1000:6.1f}ms"
                f"  {r.value or r.error or ''}"
            )

    config, r1 = nb.add("source = 'sales.csv'", name="config")
    load, r2 = nb.add(
        "import time\n"
        "time.sleep(0.4)          # pretend this is I/O\n"
        "rows = [len(source), 2, 3]",
        name="load",
    )
    factor, r3 = nb.add("n = 5", name="factor")
    scaled, r4 = nb.add("scaled = [r * n for r in rows]", name="scaled")
    report, r5 = nb.add("f'total={sum(scaled)}'", name="report")
    show("initial run", [*r1, *r2, *r3, *r4, *r5])

    show(
        "edit `config` -- refactor, same resulting value:",
        nb.set(config, "name = 'sales'\nsource = name + '.csv'"),
    )
    print("  ^ early cutoff: `load` never paid its 400ms again")

    show(
        "edit `config` -- genuinely different value:",
        nb.set(config, "source = 'returns.csv'"),
    )

    show(
        "edit `report` -- leaf only:",
        nb.set(report, "f'total={sum(scaled)} from {source}'"),
    )

    print("\nwhat the agent sees via `inspect`:")
    print(json.dumps(nb.describe(), indent=2)[:700])


if __name__ == "__main__":
    if "--serve" in sys.argv:
        serve()
    else:
        _demo()
