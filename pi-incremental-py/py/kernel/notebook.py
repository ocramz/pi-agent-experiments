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
import importlib
import itertools
import random
import time
import types

import collections
import dataclasses

from .cell import Cell, Memo, Outcome, Result, fresh_namespace, run_cell
from .edits import Edit
from .errors import DuplicateNameError, StatefulVariantError
from .graph import Graph
from .values import _hash, address, brief, env_digest, freeze, thaw
from .variants import DEFAULT, Variant, check_name, diff

_MISSING = object()

_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"  # RFC 4648 base32, lowercase
_ID_LENGTH = 6

# How much of the memo to keep, in bytes of pickled value.
_MEMO_BUDGET = 256 * 1024 * 1024

# Below this, saving a value costs more than recomputing it would. Storing
# an entry means pickling every def the cell bound, which is real work for
# a cell that was cheap to run in the first place.
_MEMO_MIN_SECONDS = 0.05


class Notebook:
    # Everything staging has to roll back. `ns` is deliberately absent:
    # staging never executes, so it cannot dirty the namespace. `addr` is
    # absent for the same reason — it describes values, and staging moves
    # no values. (The one place staging touches `ns` is retracting dropped
    # globals, which happens only after the commit point.)
    _STATE = ("cells", "graph", "pending", "done", "env")

    def __init__(
        self,
        seed: int | None = None,
        memo_budget: int = _MEMO_BUDGET,
        memo_min_seconds: float = _MEMO_MIN_SECONDS,
    ) -> None:
        self.cells: dict[str, Cell] = {}  # insertion order = execution tie-break
        self.ns: dict[str, object] = fresh_namespace()
        self.graph: Graph = Graph.of(self.cells)
        self.pending: set[str] = set()
        self.done: dict[str, Outcome] = {}
        self.env: str = env_digest()
        # Global name -> (content address, serialised size) of its current
        # value. One table rather than two, because an address and its size
        # are invalidated by the same event and must never disagree.
        self.addr: dict[str, tuple[str, int]] = {}
        # Globals the last addressing attempt could not identify. The
        # kernel already knows which values it cannot reason about — they
        # poison a key so the cell never caches — and has never said so.
        # Only names something actually read get in here, which is exactly
        # when opacity has a consequence.
        self.opaque: set[str] = set()
        # Content key -> the values that key produced. Not in `_STATE`:
        # staging moves no values, and an entry is addressed by what it
        # computed rather than by which cell currently computes it, so
        # rolling an edit back cannot orphan one.
        self.memo: collections.OrderedDict[str, Memo] = collections.OrderedDict()
        # Description -> the key that description produced. The index that
        # makes a value findable without first building its inputs. It is
        # only sound where the program is deterministic, which is a
        # stronger assumption than the memo needs, so it is consulted only
        # on request and only past `_deterministic`.
        self.by_desc: dict[str, str] = {}
        self.desc: dict[str, str] = {}
        self.memo_budget = memo_budget
        self.memo_min_seconds = memo_min_seconds
        # Cells `rerun` has been asked to force. A matching key would
        # otherwise be answered from the memo, which is exactly the
        # short-circuit the force exists to defeat.
        self._force: set[str] = set()
        # Named alternative programs. The live `cells` is the truth for
        # whichever one is current; its snapshot here is refreshed by
        # `_checkpoint` before anything reads or leaves it.
        self.current: str = DEFAULT
        self.variants: dict[str, Variant] = {
            DEFAULT: Variant(DEFAULT, None, {}, ())
        }
        self._rng = random.Random(seed)
        # Distinguishes two "never cache" keys minted in the same clock
        # tick. Deliberately outside `_STATE`: rolling a batch back must
        # not rewind it, or the rollback could hand out a key twice.
        self._nonce = itertools.count()

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
                        self.cells[cid] = Cell.of(
                            edit.src or "", edit.name, bool(edit.impure)
                        )
                        created.append(cid)
                    case "set":
                        if edit.id not in self.cells:
                            raise KeyError(f"no cell {edit.id!r}")
                        # Metadata survives a `set`: the edit carries
                        # source, and a flag it does not mention is not a
                        # request to clear one.
                        was = self.cells[edit.id]
                        kept = was.impure if edit.impure is None else bool(edit.impure)
                        self.cells[edit.id] = Cell.of(edit.src or "", was.name, kept)
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
            self._retract([name])
            self.opaque.discard(name)  # no value left to have an opinion about
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
        self,
        src: str,
        name: str | None = None,
        run: bool = True,
        impure: bool = False,
    ) -> tuple[str, list[Result]]:
        """Create a new cell; returns (generated_id, results)."""
        results, created = self.apply(
            [Edit("add", src=src, name=name, impure=impure)], run=run
        )
        return created[0], results

    def set(
        self, cid: str, src: str, run: bool = True, impure: bool | None = None
    ) -> list[Result]:
        """Modify an existing cell. `impure` left None keeps the flag the
        cell already carries."""
        return self.apply([Edit("set", id=cid, src=src, impure=impure)], run=run)[0]

    def delete(self, cid: str, run: bool = True) -> list[Result]:
        """Deleting a cell retracts its globals. This is the behaviour
        Jupyter cannot offer: there, a deleted cell's variables linger."""
        return self.apply([Edit("delete", id=cid)], run=run)[0]

    # ---- variants

    def _checkpoint(self) -> None:
        """Record the live cells as the current variant's state."""
        was = self.variants[self.current]
        self.variants[self.current] = Variant(
            was.name, was.parent, dict(self.cells), tuple(self.cells)
        )

    def _reorder(self, order: tuple[str, ...]) -> None:
        """Restore a variant's insertion order.

        Only the topological tie-break between independent cells rides on
        it, so no result depends on this. What does depend on it is that a
        variant left and returned to comes back *identical* — `cells` is
        ordered, and re-adding a cell appends it.
        """
        if tuple(self.cells) == order:
            return
        known = [cid for cid in order if cid in self.cells]
        rest = [cid for cid in self.cells if cid not in set(order)]
        self.cells = {cid: self.cells[cid] for cid in [*known, *rest]}
        self.graph = Graph.of(self.cells)

    def _accumulators_in(self, edits: list[Edit], target: dict[str, Cell]) -> list[str]:
        """Stateful cells a batch would disturb, from either side of it.

        `plan` is the existing dry run: it reports the blast radius
        without committing, which is exactly the question here. Both sides
        because a cell can be stateful in the variant being left, in the
        one being entered, or in both.
        """
        cone = self.plan(edits)
        return sorted(
            cid
            for cid in cone
            if any(
                (cell := side.get(cid)) is not None and cell.stateful
                for side in (self.cells, target)
            )
        )

    def fork(self, name: str) -> None:
        """Name a copy of the current program and move onto it.

        Free, and never refused: a fork diverges from nothing yet, so
        there is no blast radius to object to. The cost, if any, arrives
        at the first switch back.
        """
        check_name(name)
        if name in self.variants:
            raise DuplicateNameError(f"variant {name!r} already exists")
        self._checkpoint()
        self.variants[name] = Variant(
            name, self.current, dict(self.cells), tuple(self.cells)
        )
        self.current = name

    def switch(
        self,
        name: str,
        run: bool = True,
        force: bool = False,
        shallow: bool = False,
    ) -> list[Result]:
        """Move to another variant by applying the batch between them.

        Nothing here executes anything the ordinary edit path would not.
        Upstream of the divergence stays live in the namespace, the cells
        that differ are re-run, and the ones this displaces are held in
        the memo under the keys that produced them — so coming back is a
        restore rather than a recomputation.
        """
        if name not in self.variants:
            raise KeyError(f"no variant {name!r}")
        if name == self.current:
            return []
        self._checkpoint()
        target = self.variants[name]
        edits = diff(self.cells, target.cells)

        blocked = self._accumulators_in(edits, target.cells)
        if blocked and not force:
            raise StatefulVariantError(
                f"switching to {name!r} would re-run stateful "
                f"{', '.join(blocked)}, which advances rather than restores. "
                f"Pass force to proceed."
            )

        self._stage(edits, commit=True)  # may refuse; leaves us where we were
        self.current = name
        self._reorder(target.order)
        if not run:
            return []
        return self.run_shallow() if shallow else self.run()

    def drop(self, name: str) -> None:
        """Forget a variant. Invalidates nothing: the memo is addressed by
        what a computation produced, never by who asked for it."""
        if name not in self.variants:
            raise KeyError(f"no variant {name!r}")
        if name == self.current:
            raise ValueError(f"variant {name!r} is the current one")
        del self.variants[name]

    def describe_variants(self) -> dict:
        self._checkpoint()
        live = self.variants[self.current]
        return {
            "current": self.current,
            "variants": [
                {
                    "name": v.name,
                    "parent": v.parent,
                    "cells": len(v.cells),
                    "differs": sorted(
                        {e.id for e in diff(live.cells, v.cells) if e.id}
                    ),
                }
                for v in self.variants.values()
            ],
        }

    # ---- side-effect-free evaluation

    def eval_src(self, src: str) -> Result:
        """Evaluate a snippet in the live namespace WITHOUT creating a
        cell: nothing is staged, no defs are recorded, the graph is
        untouched. A trailing expression becomes the value; defs the
        snippet happens to make just land in ns (as in Jupyter), but no
        cell owns them, so nothing depends on them."""
        cell = Cell.of(src, None)
        result = run_cell(cell, self.ns, "<eval>")
        # A snippet is not supposed to own anything, but it execs in the
        # live namespace, so `/py x = 5` can clobber a global some cell
        # provides and `/py x.append(4)` can move one without rebinding it.
        # Same exposure as a cell, so the same retraction.
        self._retract((cell.defs | cell.refs) & set(self.provider))
        return result

    # ---- execution

    def _address_of(self, name: str) -> str | None:
        """A global's content address, computed once and held until the
        value it describes can have moved.

        Hashing once per *reader* per run was the old cost: five cells
        reading one frame pickled it five times a run. Holding the answer
        instead is only sound while nothing can have changed the value,
        and only execution can — so `_execute` retracts the addresses of
        every name a cell reads or binds. Between runs that leaves the
        answer standing; within a run where readers turn out to be cached
        it leaves it standing too, which is the common case and the whole
        saving. When readers really do re-execute this costs exactly what
        hashing per read cost, never more.

        An undigestable value is not cached: `None` means "assume always
        changed", and caching that would be caching the absence of an
        answer.
        """
        found = self.addr.get(name)
        if found is not None:
            return found[0]
        computed = address(self.ns.get(name))
        if computed is None:
            self.opaque.add(name)
            return None
        self.opaque.discard(name)
        self.addr[name] = computed
        return computed[0]

    def _retract(self, names) -> None:
        """Forget the recorded addresses of these globals' values.

        Addresses only. The opacity verdict is not a fact about a
        particular value but about what `digest` can answer for a value of
        that kind, and it is only ever overturned by an attempt that
        succeeds — dropping it here would erase the finding one line after
        making it, since the cell that reads an opaque global is also the
        cell whose execution retracts it.
        """
        for name in names:
            self.addr.pop(name, None)

    def _never_cache(self) -> str:
        """A key guaranteed not to match anything, this run or the last.

        "Assume always changed", spelled as an address. It has to be
        *unique*, not merely unlikely: `_fresh` asks whether this key
        equals the one the cell last ran under, so a poison that repeats is
        a cell reported `cached` over work that was never redone.
        `time_ns` alone does not promise that — two calls inside one tick
        can return the same number — so the counter is what carries the
        guarantee and the clock only keeps keys from colliding across
        processes.
        """
        return _hash(f"{time.time_ns()}:{next(self._nonce)}")

    def _key(self, cid: str) -> str:
        """Content address of a cell's next run.

        Self-refs resolve to the previous committed version in ns at this
        point (pre-exec), so stateful cells key on their history.

        `_address_of` answers exactly what `digest` used to answer here —
        same rules, same bytes — so the key for a given namespace is the
        key this always returned. What changed is only how often the
        answer is recomputed rather than reused.
        """
        cell = self.cells[cid]
        if cell.impure:
            # Declared to read something the kernel cannot address — a
            # clock, an RNG, a URL. No content names its *next* run, so it
            # gets the same poison a missing input gets, for the same
            # reason: an address that would be wrong is worse than none.
            # Cheap, because dependents key off the address of what this
            # produced, so an unchanged answer still cuts off below.
            return self._never_cache()
        inputs = []
        for name in sorted(cell.refs):
            if name not in self.provider:
                continue
            # An upstream value we simply do not have. Ordinary running can
            # never reach this — a parent precedes its child in topological
            # order, and a child whose parent failed is skipped — but a
            # shallow restore leaves the interior deliberately unbuilt, and
            # keying off `digest(None)` there would mint an address for a
            # computation whose inputs were never established. The self-edge
            # is exempt: an accumulator's first run reads nothing on purpose.
            if name not in self.ns and self.provider[name] != cid:
                return self._never_cache()  # missing input: never cache
            inputs.append((name, self._address_of(name)))
        if any(d is None for _, d in inputs):
            return self._never_cache()  # unhashable input: never cache
        key = _hash(cell.src + repr(inputs))
        return _hash(key + self.env) if cell.imports else key

    def descriptions(self) -> dict[str, str]:
        """A Merkle hash per cell of its *description*: its source, the
        environment if it imports, and the same for every ancestor.

        The other identity in the kernel, and the complement of `_key`.
        A key is built from what the inputs turned out to *be*, so it
        cannot be known until they have been computed — but it converges,
        because two programs that arrive at the same values share it. A
        description is built from what the program *says*, so it can be
        computed without running anything — but it never converges, since
        two different sources describing the same value stay different.

        Hence both: the description is what makes a value findable before
        its inputs exist, the key is what makes it correct to share.
        """
        out: dict[str, str] = {}
        for cid in self.topo():
            cell = self.cells[cid]
            # `impure` is part of what the program says, and — unlike every
            # other such fact — it is not inside `src`, so it has to be
            # mixed in by hand or two different programs would describe
            # identically.
            said = cell.src + ("\x00impure" if cell.impure else "")
            base = _hash(said + repr(sorted(out[p] for p in self.parents_of[cid])))
            out[cid] = _hash(base + self.env) if cell.imports else base
        return out

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
        # Refs as well as defs. A cell rebinds its defs, but it can mutate
        # anything it *reads* in place — `data.append(4)` binds nothing —
        # and an in-place mutation moves the value without moving the name.
        # Hashing per read used to catch that for free; a recorded address
        # has to be retracted instead, and execution is the only thing that
        # can mutate, so this is the whole exposure. Dropping rather than
        # recomputing keeps hashing lazy: a global nothing goes on to read
        # is never hashed at all.
        self._retract(cell.defs | cell.refs)
        self.done[cid] = Outcome(key, result)
        if result.status == "ran":
            self._remember(cid, key, result)
        return result

    # ---- the memo: what a computation produced, keyed by its address

    def _remember(self, cid: str, key: str, result: Result) -> None:
        """Save a successful run's defs under the key that produced them.

        All or nothing: a cell whose defs cannot all be written back is
        not restorable, and half its namespace is worse than none of it.
        """
        if self.cells[cid].impure:
            # Its key is a fresh nonce, so an entry stored under one could
            # never be found again — only accumulate.
            return
        if result.seconds < self.memo_min_seconds:
            return
        blobs: dict[str, bytes] = {}
        modules: dict[str, str] = {}
        for name in self.cells[cid].defs:
            if name not in self.ns:
                return  # a def the cell left unbound; `_fresh` refuses these too
            value = self.ns[name]
            if isinstance(value, types.ModuleType):
                modules[name] = value.__name__  # re-imported, not unpickled
                continue
            frozen = freeze(value)
            if frozen is None:
                return  # a function, or something unpicklable
            blobs[name] = frozen
        self.memo[key] = Memo(
            blobs, sum(map(len, blobs.values())), result.seconds, result, modules
        )
        self.memo.move_to_end(key)
        self._index(cid, key)
        self._evict()

    def _index(self, cid: str, key: str) -> None:
        """Record that this description produced this key."""
        described = self.desc.get(cid)
        if described is not None:
            self.by_desc[described] = key

    def _deterministic(self, cid: str) -> bool:
        """Whether a description can be trusted to name one value.

        Three things break the equation "same program, same result". A
        stateful cell's value is a function of how many times it has run,
        not of what it says. An impure cell's is a function of when it ran
        and of what answered — a clock, a URL — which its source likewise
        does not record. An opaque global is one `digest` cannot identify,
        so nothing downstream of it was ever established to be a function
        of anything. Any of the three in the cone and the description is a
        name for more than one value.

        The first two are declared or structural and the third is
        discovered, but they fail the same way, so they are refused in the
        same place.
        """
        cone = self.graph.ancestors(cid) | {cid}
        if any(self.cells[c].stateful or self.cells[c].impure for c in cone):
            return False
        return not ({n for c in cone for n in self.cells[c].refs} & self.opaque)

    def _recall(self, cid: str, key: str) -> Result | None:
        """Put back what this key produced before, or None for a miss."""
        if cid in self._force:
            return None
        memo = self.memo.get(key)
        if memo is None:
            return None
        try:
            values = {name: thaw(blob) for name, blob in memo.blobs.items()}
            for name, module in memo.modules.items():
                values[name] = importlib.import_module(module)
        except Exception:
            del self.memo[key]  # an entry that will not load is not an answer
            return None
        self.ns.update(values)
        self._retract(values)  # same content, new objects
        self.memo.move_to_end(key)
        self._index(cid, key)
        # Attributed to this cell, not to whichever one first computed the
        # key — under convergence they are not the same cell. Status stays
        # `ran`, because that is what `_fresh` asks of a committed run; the
        # `restored` status describes this event, not the stored one.
        self.done[cid] = Outcome(key, dataclasses.replace(memo.result, cell=cid))
        return Result(cid, "restored", 0.0, value=memo.result.value)

    def _evict(self) -> None:
        """Drop entries until the budget holds, cheapest first.

        Cost per byte rather than recency: an LRU would drop a
        twenty-minute model fit to keep a frame that reloads in forty
        seconds. Both numbers are already on hand — `seconds` from the
        run that produced the entry, `nbytes` from writing it.
        """
        total = sum(m.nbytes for m in self.memo.values())
        if total <= self.memo_budget:
            return
        by_worth = sorted(self.memo, key=lambda k: self.memo[k].seconds / max(self.memo[k].nbytes, 1))
        for key in by_worth:
            if total <= self.memo_budget:
                return
            total -= self.memo.pop(key).nbytes

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

    def _candidates(self) -> set[str]:
        out: set[str] = set()
        for cid in self.pending:
            out |= {cid} | self.descendants(cid)
        return out & set(self.cells)

    def run_shallow(self) -> list[Result]:
        """Answer what can be answered without building the interior.

        Deepest first: a cell whose description is already indexed is put
        back directly, and everything it was built out of is then not
        needed — which is the point, and the reason this walks the
        topological order backwards. What is skipped stays `pending`, so
        the namespace is honestly partial and an ordinary `run` fills it in.

        Narrower than it looks, deliberately. This can only skip work whose
        *inputs* are absent, since anything still live in the namespace is
        answered more cheaply by the ordinary path — so what it really buys
        is the answer to a question without the intermediates behind it.
        """
        if not self.pending:
            return []
        candidates = self._candidates()
        self.desc = self.descriptions()

        results: list[Result] = []
        covered: set[str] = set()
        for cid in reversed(self.topo(candidates)):
            if cid in covered or not self._deterministic(cid):
                continue
            key = self.by_desc.get(self.desc.get(cid, ""))
            if key is None or key not in self.memo:
                continue
            restored = self._recall(cid, key)
            if restored is None:
                continue
            results.append(restored)
            covered |= self.graph.ancestors(cid) | {cid}

        self.pending = candidates - {r.cell for r in results}
        return results

    def run(self) -> list[Result]:
        if not self.pending:
            return []

        candidates = self._candidates()
        self.desc = self.descriptions()

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
            # Not live in the namespace, but this computation may have been
            # done before — under this cell, or under another program that
            # arrived at the same inputs.
            restored = self._recall(cid, key)
            if restored is not None:
                results.append(restored)
                continue
            result = self._execute(cid, key)
            if result.status == "error":
                failed.add(cid)
                skip |= self.descendants(cid)
            results.append(result)

        self._force.clear()
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
        self._force.add(cid)  # ...and so would the memo, one layer down
        self.pending |= {cid} | self.descendants(cid)
        return self.run()

    def run_all(self, restart: bool = True) -> list[Result]:
        """Evaluate everything from the top. With restart (the default)
        the namespace and the cache are dropped first, so this is a true
        replay: the notebook is a program, not a transcript."""
        if restart:
            self.ns = fresh_namespace()
            self.done.clear()
            self.addr.clear()
            self.opaque.clear()
            # The memo too, and the index over it: this is the recovery
            # move, and a replay that answers itself out of the cache has
            # replayed nothing.
            self.memo.clear()
            self.by_desc.clear()
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
            "variant": self.current,
            "cells": [
                {
                    "id": cid,
                    "name": self.cells[cid].name,
                    "defines": sorted(self.cells[cid].defs),
                    "depends_on": sorted(self.parents_of[cid]),
                    "stateful": self.cells[cid].stateful,
                    "impure": self.cells[cid].impure,
                    "failing": cid in failing,
                }
                for cid in self.topo()
            ],
            "names": {cid: c.name for cid, c in self.cells.items() if c.name},
            "globals": self.globals_brief(),
            "pending": sorted(self.pending),
            "failing": sorted(failing),
            # Values the kernel cannot identify — a socket, a handle, a live
            # model. A cell reading one never caches, never restores, and is
            # re-run every time. Nothing here is broken; it is the boundary
            # of what `digest` can answer, and it was previously invisible.
            "opaque": sorted(self.opaque & set(self.provider)),
        }
