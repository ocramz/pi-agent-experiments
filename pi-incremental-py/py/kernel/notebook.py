"""The notebook: cells, a live namespace, and the rules moving between them.

Four responsibilities, in the order the sections below take them:

- **identity** — minting cell ids and policing display names;
- **staging** — applying a batch of edits atomically, validating the final
  graph, and rolling back to the previous state if anything refuses;
- **execution** — the content-addressed key, the versioned exec, and the
  topo-ordered run that skips whatever the key says is still fresh;
- **introspection** — the view an agent gets back instead of a transcript.

The graph itself lives in `graph.Graph`, which is rebuilt wholesale on
every accepted edit; `provider`/`parents_of`/`kids` here are read-only
views onto it.
"""

from __future__ import annotations

import copy
import random
import time

from .cell import Cell, Outcome, Result, fresh_namespace, run_cell
from .edits import Edit
from .errors import DuplicateNameError
from .graph import Graph
from .values import _hash, brief, digest, env_digest

_MISSING = object()

_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"  # RFC 4648 base32, lowercase
_ID_LENGTH = 6


class Notebook:
    # Everything staging has to roll back. `ns` is deliberately absent:
    # staging never executes, so it cannot dirty the namespace.
    _STATE = ("cells", "graph", "pending", "done", "env")

    def __init__(self, seed: int | None = None) -> None:
        self.cells: dict[str, Cell] = {}  # insertion order = execution tie-break
        self.ns: dict[str, object] = fresh_namespace()
        self.graph: Graph = Graph.of(self.cells)
        self.pending: set[str] = set()
        self.done: dict[str, Outcome] = {}
        self.env: str = env_digest()
        self._rng = random.Random(seed)

    # ---- identity

    def _new_id(self) -> str:
        while True:
            cid = "".join(self._rng.choice(_ID_ALPHABET) for _ in range(_ID_LENGTH))
            if cid not in self.cells:
                return cid

    def _check_name(self, name: str | None) -> None:
        if name is None:
            return
        if not name.isidentifier():
            raise ValueError(f"cell name {name!r} is not a valid identifier")
        for cid, cell in self.cells.items():
            if cell.name == name:
                raise DuplicateNameError(f"name {name!r} already used by cell {cid}")

    # ---- graph queries (the graph owns them; these are the notebook's view)

    @property
    def provider(self) -> dict[str, str]:
        """Global name -> the cell that binds it."""
        return self.graph.provider

    @property
    def parents_of(self) -> dict[str, frozenset[str]]:
        return self.graph.parents_of

    @property
    def kids(self) -> dict[str, frozenset[str]]:
        return self.graph.kids

    def parents(self, cid: str) -> set[str]:
        return self.graph.parents(cid)

    def descendants(self, cid: str) -> set[str]:
        return self.graph.descendants(cid)

    def topo(self, subset: set[str] | None = None) -> list[str]:
        return self.graph.topo(subset)

    def stateful(self, cid: str) -> bool:
        return self.cells[cid].stateful

    # ---- staging

    def _save(self) -> dict:
        return {field: copy.copy(getattr(self, field)) for field in self._STATE}

    def _restore(self, snapshot: dict) -> None:
        self.__dict__.update(snapshot)

    def _stage(self, edits: list[Edit], commit: bool) -> tuple[set[str], list[str]]:
        """Apply a batch of edits atomically. Validation happens on the
        final graph only. Returns (blast radius, ids minted for adds)."""
        saved = self._save()
        affected: set[str] = set()
        created: list[str] = []

        # Blast radius in the OLD graph, captured before anything moves.
        # Without this, renaming a cell's output silently orphans its
        # dependents: the edge is gone by the time we look for it.
        for edit in edits:
            if edit.id in self.cells:
                affected |= {edit.id} | self.descendants(edit.id)

        try:
            for edit in edits:
                match edit.op:
                    case "add":
                        cid = edit.id or self._new_id()
                        if cid in self.cells:
                            raise KeyError(f"cell {cid!r} already exists")
                        self._check_name(edit.name)
                        self.cells[cid] = Cell.of(edit.src or "", edit.name)
                        created.append(cid)
                    case "set":
                        if edit.id not in self.cells:
                            raise KeyError(f"no cell {edit.id!r}")
                        name = self.cells[edit.id].name
                        self.cells[edit.id] = Cell.of(edit.src or "", name)
                    case "delete":
                        if edit.id not in self.cells:
                            raise KeyError(f"no cell {edit.id!r}")
                        del self.cells[edit.id]
                    case _:
                        raise ValueError(f"bad edit {edit!r}")

            self.graph = Graph.of(self.cells)  # rebuilds, validates, or refuses

            # ...and the blast radius in the NEW graph.
            for cid in [*(e.id for e in edits), *created]:
                if cid in self.cells:
                    affected |= {cid} | self.descendants(cid)
            affected &= set(self.cells)
        except Exception:
            self._restore(saved)
            raise

        if not commit:
            self._restore(saved)
            return affected, created

        for name in set(saved["graph"].provider) - set(self.provider):
            self.ns.pop(name, None)  # retract dropped globals
        for cid in set(saved["cells"]) - set(self.cells):
            self.done.pop(cid, None)  # a recycled id must not inherit a cache hit
        self.pending |= affected
        return affected, created

    def plan(self, edits: list[Edit]) -> set[str]:
        """Blast radius of a batch, without executing it."""
        return self._stage(edits, commit=False)[0]

    def apply(
        self, edits: list[Edit], run: bool = True
    ) -> tuple[list[Result], list[str]]:
        _, created = self._stage(edits, commit=True)
        return (self.run() if run else []), created

    # ---- public editing API

    def add(
        self, src: str, name: str | None = None, run: bool = True
    ) -> tuple[str, list[Result]]:
        """Create a new cell; returns (generated_id, results)."""
        results, created = self.apply([Edit("add", src=src, name=name)], run=run)
        return created[0], results

    def set(self, cid: str, src: str, run: bool = True) -> list[Result]:
        """Modify an existing cell."""
        return self.apply([Edit("set", id=cid, src=src)], run=run)[0]

    def delete(self, cid: str, run: bool = True) -> list[Result]:
        """Deleting a cell retracts its globals. This is the behaviour
        Jupyter cannot offer: there, a deleted cell's variables linger."""
        return self.apply([Edit("delete", id=cid)], run=run)[0]

    # ---- side-effect-free evaluation

    def eval_src(self, src: str) -> Result:
        """Evaluate a snippet in the live namespace WITHOUT creating a
        cell: nothing is staged, no defs are recorded, the graph is
        untouched. A trailing expression becomes the value; defs the
        snippet happens to make just land in ns (as in Jupyter), but no
        cell owns them, so nothing depends on them."""
        return run_cell(Cell.of(src, None), self.ns, "<eval>")

    # ---- execution

    def _key(self, cid: str) -> str:
        """Content address of a cell's next run.

        Self-refs resolve to the previous committed version in ns at this
        point (pre-exec), so stateful cells key on their history.
        """
        cell = self.cells[cid]
        inputs = sorted(
            (name, digest(self.ns.get(name)))
            for name in cell.refs
            if name in self.provider
        )
        if any(d is None for _, d in inputs):
            return _hash(f"{time.time_ns()}")  # unhashable input: never cache
        key = _hash(cell.src + repr(inputs))
        return _hash(key + self.env) if cell.imports else key

    def _execute(self, cid: str, key: str) -> Result:
        """Exec one cell against the namespace.

        Self-references read the last committed version, because defs are
        not popped before exec; on failure the namespace is restored from
        that committed version, so a crash leaves no half-written state.
        """
        cell = self.cells[cid]
        prior = {n: self.ns.get(n, _MISSING) for n in cell.defs}
        result = run_cell(cell, self.ns, cid)
        if result.status == "error":
            for name, was in prior.items():
                if was is _MISSING:
                    self.ns.pop(name, None)
                else:
                    self.ns[name] = was
        self.done[cid] = Outcome(key, result)
        return result

    def _fresh(self, cid: str, key: str) -> bool:
        """A cell may be skipped only if the same key already produced a
        successful run *and* every global it owns is still in place."""
        done = self.done.get(cid)
        return (
            done is not None
            and done.key == key
            and done.result.status == "ran"
            and all(name in self.ns for name in self.cells[cid].defs)
        )

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
            key = self._key(cid)
            if self._fresh(cid, key):
                value = self.done[cid].result.value
                results.append(Result(cid, "cached", 0.0, value=value))
                continue
            result = self._execute(cid, key)
            if result.status == "error":
                failed.add(cid)
                skip |= self.descendants(cid)
            results.append(result)

        self.pending = failed | skip
        return results

    def rerun(self, cid: str) -> list[Result]:
        """Force a re-run of one cell and everything downstream.

        On a stateful cell (a self-edge) this *advances* the accumulator
        rather than refreshing it — by design.
        """
        if cid not in self.cells:
            raise KeyError(f"no cell {cid!r}")
        self.done.pop(cid, None)  # a matching key would short-circuit the force
        self.pending |= {cid} | self.descendants(cid)
        return self.run()

    def run_all(self, restart: bool = True) -> list[Result]:
        """Evaluate everything from the top. With restart (the default)
        the namespace and the cache are dropped first, so this is a true
        replay: the notebook is a program, not a transcript."""
        if restart:
            self.ns = fresh_namespace()
            self.done.clear()
        self.pending = set(self.cells)
        return self.run()

    # ---- introspection

    def failing(self) -> list[str]:
        return sorted(
            cid
            for cid in self.cells
            if (o := self.done.get(cid)) is not None and o.result.status == "error"
        )

    def globals_brief(self) -> dict[str, str]:
        return {n: brief(self.ns[n]) for n in sorted(self.provider) if n in self.ns}

    def describe(self) -> dict:
        """The view the agent gets back, instead of a scrolling transcript."""
        failing = set(self.failing())
        return {
            "cells": [
                {
                    "id": cid,
                    "name": self.cells[cid].name,
                    "defines": sorted(self.cells[cid].defs),
                    "depends_on": sorted(self.parents_of[cid]),
                    "stateful": self.cells[cid].stateful,
                    "failing": cid in failing,
                }
                for cid in self.topo()
            ],
            "names": {cid: c.name for cid, c in self.cells.items() if c.name},
            "globals": self.globals_brief(),
            "pending": sorted(self.pending),
            "failing": sorted(failing),
        }
