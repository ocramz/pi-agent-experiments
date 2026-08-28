"""The DAG implied by a set of cells.

Cells declare nothing, so every edge here is derived: a cell that binds a
global *provides* it, a cell that reads one *depends* on its provider.
Invariant : The three tables (`provider`, `parents_of`, `kids`) must be
built or replaced in parallel.

Immutable, and validated at construction: a valid `Graph` has
- a single provider per name and
- no cycles.
That is also what lets the notebook's staging roll back, by keeping the
previous instance.
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass

from .cell import Cell
from .errors import CycleError, MultipleDefinitionError


@dataclass(frozen=True)
class Graph:
    provider: dict[str, str]  # global name -> owning cell id
    parents_of: dict[str, frozenset[str]]
    kids: dict[str, frozenset[str]]
    order: tuple[str, ...]  # the cells' insertion order: the topo tie-break

    @classmethod
    def of(cls, cells: dict[str, Cell]) -> Graph:
        """Derive the whole graph from the cells, or refuse.

        Final graph only: a rename, a split, or interposing a node cannot
        be expressed as a sequence of individually-valid single-cell edits,
        so validation belongs here and not on each edit.
        """
        provider: dict[str, str] = {}
        for cid, cell in cells.items():  # insertion order: first definer wins
            for name in cell.defs:
                if name in provider:
                    raise MultipleDefinitionError(
                        f"{name!r} defined by both {provider[name]} and {cid}"
                    )
                provider[name] = cid

        # Self-edges are temporal, not topological, so a cell is never its
        # own parent; builtin names count only when some cell provides
        # (shadows) them, which is exactly when they are in `provider`.
        #
        # The `frozenset` is load-bearing: a cell reading
        # several names from one parent must yield exactly one edge,
        # because `topo` counts in-degree from `parents_of` and decrements
        # it once per entry in `kids`. Let the two disagree on
        # multiplicity and `indeg` never reaches zero, which surfaces as a
        # spurious `CycleError` — a complaint about graph shape that says
        # nothing about the dedup that actually broke.
        parents_of = {
            cid: frozenset(
                provider[n] for n in cell.refs if n in provider and provider[n] != cid
            )
            for cid, cell in cells.items()
        }
        kids: dict[str, set[str]] = {cid: set() for cid in cells}
        for cid, parents in parents_of.items():
            for parent in parents:
                kids[parent].add(cid)

        graph = cls(
            provider,
            parents_of,
            {cid: frozenset(children) for cid, children in kids.items()},
            tuple(cells),
        )
        graph.topo()  # cycle check
        return graph

    def parents(self, cid: str) -> set[str]:
        """Providing cells this cell reads."""
        return set(self.parents_of[cid])

    def descendants(self, cid: str) -> set[str]:
        seen: set[str] = set()
        stack = [cid]
        while stack:
            for kid in self.kids.get(stack.pop(), ()):
                if kid not in seen:
                    seen.add(kid)
                    stack.append(kid)
        return seen

    def taint(self, seeds: set[str]) -> set[str]:
        """Seeds plus everything downstream of them.

        Volatility is a property of *values*, not only of cells, and it
        travels along edges `digest` cannot see. `def now(): return
        time.time()` has a perfectly stable digest — code, closures,
        defaults and globals all sit still — so a cell calling `now()`
        keys constant and caches a stale answer forever. Marking the
        defining cell alone fixes nothing; its readers have to inherit.

        Coarser than strictly necessary: `t1 = t0 + 1` would have
        re-keyed on its own, because t0's digest really does move. Taking
        the whole cone over-invalidates in that case, which is the
        direction the analysis already errs in everywhere else.
        """
        return seeds | {d for cid in seeds for d in self.descendants(cid)}

    def topo(self, subset: set[str] | None = None) -> list[str]:
        """topological sort by Kahn's algorithm: insertion order as
        the tie-break so the execution order of independent cells
        never depends on their ids.
        In-degree is counted within `subset` only: parents outside it
        are, by definition, already up to date."""
        ids = set(self.order) if subset is None else set(subset) & set(self.order)
        by_index = self.order
        index = {cid: i for i, cid in enumerate(by_index)}
        indeg = {i: len(self.parents_of[i] & ids) for i in ids}
        ready = [index[i] for i in ids if indeg[i] == 0]
        heapq.heapify(ready)
        order: list[str] = []
        while ready:
            node = by_index[heapq.heappop(ready)]
            order.append(node)
            for kid in self.kids[node]:
                if kid not in indeg:
                    continue
                indeg[kid] -= 1
                if indeg[kid] == 0:
                    heapq.heappush(ready, index[kid])
        if len(order) != len(ids):
            raise CycleError(f"cycle among {sorted(ids - set(order))}")
        return order
