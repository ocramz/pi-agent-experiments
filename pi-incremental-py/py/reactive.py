"""A minimal reactive notebook kernel.

Cells never declare their dependencies. We recover the DAG by static
analysis: each cell's *defs* (names it binds at module level) and *refs*
(module-level globals it reads). An edge A -> B exists when B.refs meets
A.defs. Editing a cell re-runs it and everything downstream, in
topological order.

Identity: a cell is identified by a kernel-generated 6-char base32 id
(the `cells` dict key). An optional human/agent-chosen `name` is display
metadata only and is never used for lookup.

Versioned namespaces: a self-reference (`x = x + 1`) is a *temporal*
edge — the cell reads the last committed version of its own defs. On
failure the namespace is restored from that committed version, so a
crash never leaves half-written state. Replaying from scratch starts
with an empty version store; the blessed accumulator idiom is

    try:
        x = x + 1
    except NameError:
        x = None

`None` is the neutral "nothing yet" — the except branch exists so the
cell is meaningful from scratch; pick whatever initial value the cell
should start from. This converges between incremental runs and full
replays.

The kernel also supports `eval_src`: evaluate a snippet in the live
namespace without creating a cell (no defs recorded, no graph impact) —
used by human-facing `/py` interactions.
"""

from __future__ import annotations

import ast
import builtins
import io
import random
import symtable
from collections import deque
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass
from time import perf_counter

BUILTIN_NAMES = frozenset(dir(builtins))

_MISSING = object()

_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"  # RFC 4648 base32, lowercase
_ID_LENGTH = 6


class CycleError(Exception):
    """Cells form a dependency cycle; no valid execution order exists."""


class MultipleDefinitionError(Exception):
    """Two cells bind the same global, so the graph would be ambiguous."""


class DuplicateNameError(Exception):
    """Two cells carry the same display name."""


# --------------------------------------------------------------- analysis

_COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)


def _comprehension_targets(tree: ast.AST) -> set[str]:
    """Names bound by `for x in ...` clauses inside comprehensions.

    Since PEP 709 (Python 3.12) comprehensions are inlined, so these show
    up in the enclosing symbol table as assigned even though they never
    bind at runtime. Left uncorrected they become phantom globals.
    """
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, _COMPREHENSIONS):
            for gen in node.generators:
                names |= {n.id for n in ast.walk(gen.target) if isinstance(n, ast.Name)}
    return names


def _statement_bindings(tree: ast.AST) -> set[str]:
    """Names bound by real binding statements, used to tell a genuine
    global apart from a comprehension variable that merely shares its
    name (`r = 1` followed by `[... for r in rows]` really does bind r).
    Walrus targets are included since they can bind in enclosing scope."""
    names: set[str] = set()
    for node in ast.walk(tree):
        targets: list[ast.AST] = []
        if isinstance(node, ast.Assign):
            targets = list(node.targets)
        elif isinstance(
            node, (ast.AugAssign, ast.AnnAssign, ast.For, ast.AsyncFor, ast.NamedExpr)
        ):
            targets = [node.target]
        elif isinstance(node, ast.withitem):
            targets = [node.optional_vars] if node.optional_vars else []
        elif (
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            or isinstance(node, ast.ExceptHandler)
            and node.name
        ):
            names.add(node.name)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            names |= {(a.asname or a.name).split(".")[0] for a in node.names}
        for target in targets:
            names |= {n.id for n in ast.walk(target) if isinstance(n, ast.Name)}
    return names


def _deleted_names(tree: ast.AST) -> set[str]:
    """`del x` does not define x; symtable marks it assigned anyway."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Delete):
            for target in node.targets:
                names |= {n.id for n in ast.walk(target) if isinstance(n, ast.Name)}
    return names


def analyze(src: str) -> tuple[frozenset[str], frozenset[str]]:
    """Return (defs, refs) for one cell.

    Uses `symtable`, not a hand-rolled AST walk, because scoping is where
    naive implementations break: function parameters, comprehension
    variables and class attributes are *not* global reads, while a bare
    name inside a nested function usually is.

    Deliberately pure: refs keep self-defs (a `x = x + 1` self-edge is a
    temporal dependency the executor must see) and builtin names (the
    graph, which knows the providers, decides whether `len` is a real
    edge because some cell shadows it).
    """
    top = symtable.symtable(src, "<cell>", "exec")
    defs: set[str] = set()
    refs: set[str] = set()

    for sym in top.get_symbols():
        name = sym.get_name()
        if sym.is_imported():
            defs.add(name)  # importing is defining, not a temporal read
        elif sym.is_assigned():
            defs.add(name)
            # A name both read and assigned (`x = x + 1`) is also a
            # temporal self-ref.
            if sym.is_referenced():
                refs.add(name)
        elif sym.is_referenced():
            refs.add(name)

    # Descend into functions, classes and comprehensions. A name that is
    # global *there* is a read of our namespace, deferred but real.
    stack = list(top.get_children())
    while stack:
        table = stack.pop()
        stack.extend(table.get_children())
        for sym in table.get_symbols():
            if not sym.is_global():
                continue
            if sym.is_declared_global() and sym.is_assigned():
                defs.add(sym.get_name())  # `global x; x = ...`
            elif sym.is_referenced():
                refs.add(sym.get_name())

    tree = ast.parse(src)
    phantom = _comprehension_targets(tree) - _statement_bindings(tree)
    defs -= phantom | _deleted_names(tree)
    refs -= phantom
    return frozenset(defs), frozenset(refs)


def compile_cell(src: str):
    """Compile a cell, splitting off a trailing expression.

    This is the one piece of Jupyter semantics worth keeping: if the last
    statement is an expression, evaluate rather than execute it so the
    cell has a display value.
    """
    tree = ast.parse(src)
    tail = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        tail = ast.Expression(tree.body.pop().value)
        ast.copy_location(tail, tail.body)
    body_code = compile(tree, "<cell>", "exec")
    tail_code = compile(tail, "<cell>", "eval") if tail is not None else None
    return body_code, tail_code


def brief(value: object, limit: int = 120) -> str:
    """One-line value summary. Agents need shape, not contents."""
    if value is None:
        return "None"
    try:
        # numpy, pandas, torch
        size = value.shape  # type: ignore[attr-defined]
        return f"{type(value).__name__}{tuple(size)}"
    except (AttributeError, TypeError):
        pass
    try:
        return f"{type(value).__name__}({len(value)})"  # type: ignore[arg-type]
    except TypeError:
        pass
    text = repr(value)
    return text if len(text) <= limit else text[:limit] + "..."


@dataclass
class Cell:
    src: str
    name: str | None  # display metadata only; never a lookup key
    defs: frozenset[str]
    refs: frozenset[str]
    body: object
    tail: object | None = None
    error: BaseException | None = None


@dataclass
class Result:
    """The one currency of execution, base class included."""

    cell: str
    status: str  # ran | cached | error
    seconds: float
    value: str | None = None
    error: str | None = None
    output: str = ""


# --------------------------------------------------------------- notebook


class Notebook:
    def __init__(self, seed: int | None = None) -> None:
        self.cells: dict[str, Cell] = {}  # insertion order = execution tie-break
        self.ns: dict[str, object] = {"__builtins__": builtins}
        self.provider: dict[str, str] = {}  # global name -> owning cell id
        self.pending: set[str] = set()
        self._versions: dict[str, dict[str, object]] = {}  # cid -> committed defs
        self._kids: dict[str, set[str]] = {}
        self._rng = random.Random(seed)

    # ---- identity

    def _new_id(self) -> str:
        while True:
            cid = "".join(self._rng.choice(_ID_ALPHABET) for _ in range(_ID_LENGTH))
            if cid not in self.cells:
                return cid

    def _check_name(self, name: str | None, ignore: str | None = None) -> None:
        if name is None:
            return
        if not name.isidentifier():
            raise ValueError(f"cell name {name!r} is not a valid identifier")
        for cid, cell in self.cells.items():
            if cid != ignore and cell.name == name:
                raise DuplicateNameError(f"name {name!r} already used by cell {cid}")

    # ---- graph queries

    def parents(self, cid: str) -> set[str]:
        """Providing cells this cell reads. Self-edges are temporal, not
        topological, so they are excluded here; builtin names count only
        when some cell actually provides (shadows) them."""
        prov = self.provider
        return {prov[n] for n in self.cells[cid].refs if n in prov and prov[n] != cid}

    def children(self, cid: str) -> set[str]:
        return set(self._kids.get(cid, ()))

    def stateful(self, cid: str) -> bool:
        cell = self.cells[cid]
        return bool(cell.refs & cell.defs)

    def descendants(self, cid: str) -> set[str]:
        seen: set[str] = set()
        stack = [cid]
        while stack:
            for kid in self.children(stack.pop()):
                if kid not in seen:
                    seen.add(kid)
                    stack.append(kid)
        return seen

    def topo(self, subset: set[str] | None = None) -> list[str]:
        """Kahn's algorithm, insertion order as the tie-break so the
        execution order of independent cells never depends on their ids.
        In-degree is counted within `subset` only: parents outside it
        are, by definition, already up to date."""
        ids = set(self.cells) if subset is None else set(subset)
        indeg = {i: len(self.parents(i) & ids) for i in ids}
        ready = deque(i for i in self.cells if i in ids and indeg[i] == 0)
        order: list[str] = []
        while ready:
            node = ready.popleft()
            order.append(node)
            for kid in self.cells:
                if kid not in self._kids.get(node, ()) or kid not in ids:
                    continue
                indeg[kid] -= 1
                if indeg[kid] == 0:
                    ready.append(kid)
        if len(order) != len(ids):
            raise CycleError(f"cycle among {sorted(ids - set(order))}")
        return order

    def _rebuild_graph(self) -> None:
        """Recompute provider, adjacency and validate. Final graph only:
        a rename, a split, or interposing a node cannot be expressed as a
        sequence of individually-valid single-cell edits."""
        provider: dict[str, str] = {}
        for cid in self.cells:  # insertion order: first definer is reported
            for name in self.cells[cid].defs:
                if name in provider:
                    raise MultipleDefinitionError(
                        f"{name!r} defined by both {provider[name]} and {cid}"
                    )
                provider[name] = cid
        self.provider = provider
        kids: dict[str, set[str]] = {cid: set() for cid in self.cells}
        for cid in self.cells:
            for parent in self.parents(cid):
                kids[parent].add(cid)
        self._kids = kids
        self.topo()  # cycle check

    # ---- staging

    def _snapshot_extra(self) -> object:
        return None

    def _restore_extra(self, state: object) -> None:
        pass

    def _stage(self, edits: list[tuple], commit: bool) -> set[str]:
        """Apply a batch of edits atomically.

        Edit ops: ("create", cid, src, name), ("modify", cid, src),
        ("delete", cid). Validation happens on the final graph only.
        """
        saved = (
            dict(self.cells),
            dict(self.provider),
            set(self.pending),
            dict(self._versions),
            {k: set(v) for k, v in self._kids.items()},
        )
        extra = self._snapshot_extra()
        affected: set[str] = set()

        # Blast radius in the OLD graph, captured before anything moves.
        # Without this, renaming a cell's output silently orphans its
        # dependents: the edge is gone by the time we look for it.
        for edit in edits:
            cid = edit[1]
            if cid in self.cells:
                affected |= {cid} | self.descendants(cid)

        try:
            for edit in edits:
                match edit:
                    case ("create", cid, src, name):
                        if cid in self.cells:
                            raise KeyError(f"cell {cid!r} already exists")
                        self._check_name(name)
                        defs, refs = analyze(src)
                        body, tail = compile_cell(src)
                        self.cells[cid] = Cell(src, name, defs, refs, body, tail)
                    case ("modify", cid, src):
                        if cid not in self.cells:
                            raise KeyError(f"no cell {cid!r}")
                        defs, refs = analyze(src)
                        body, tail = compile_cell(src)
                        name = self.cells[cid].name
                        self.cells[cid] = Cell(src, name, defs, refs, body, tail)
                    case ("delete", cid):
                        if cid not in self.cells:
                            raise KeyError(f"no cell {cid!r}")
                        del self.cells[cid]
                    case _:
                        raise ValueError(f"bad edit {edit!r}")

            self._rebuild_graph()

            # ...and the blast radius in the NEW graph.
            for edit in edits:
                cid = edit[1]
                if cid in self.cells:
                    affected |= {cid} | self.descendants(cid)
            affected &= set(self.cells)
        except Exception:
            self.cells, self.provider, self.pending, self._versions, self._kids = saved
            self._restore_extra(extra)
            raise

        if not commit:
            self.cells, self.provider, self.pending, self._versions, self._kids = saved
            self._restore_extra(extra)
            return affected

        for name in set(saved[1]) - set(self.provider):
            self.ns.pop(name, None)  # retract dropped globals
        for cid in set(saved[0]) - set(self.cells):
            self._versions.pop(cid, None)
        self.pending |= affected
        return affected

    def plan(self, edits: list[tuple]) -> set[str]:
        """Blast radius of a batch, without executing it."""
        return self._stage(edits, commit=False)

    def apply(self, edits: list[tuple], run: bool = True) -> list[Result]:
        self._stage(edits, commit=True)
        return self.run() if run else []

    # ---- public editing API

    def add(self, src: str, name: str | None = None, run: bool = True):
        """Create a new cell; returns (generated_id, results)."""
        cid = self._new_id()
        return cid, self.apply([("create", cid, src, name)], run=run)

    def set(self, cid: str, src: str, run: bool = True) -> list[Result]:
        """Modify an existing cell."""
        return self.apply([("modify", cid, src)], run=run)

    def delete(self, cid: str, run: bool = True) -> list[Result]:
        """Deleting a cell retracts its globals. This is the behaviour
        Jupyter cannot offer: there, a deleted cell's variables linger."""
        return self.apply([("delete", cid)], run=run)

    # ---- side-effect-free evaluation

    def eval_src(self, src: str) -> Result:
        """Evaluate a snippet in the live namespace WITHOUT creating a
        cell: nothing is staged, no defs are recorded, the graph is
        untouched. A trailing expression becomes the value; defs the
        snippet happens to make just land in ns (as in Jupyter), but no
        cell owns them, so nothing depends on them."""
        body, tail = compile_cell(src)
        buf = io.StringIO()
        started = perf_counter()
        try:
            with redirect_stdout(buf), redirect_stderr(buf):
                exec(body, self.ns)
                value = eval(tail, self.ns) if tail else None
        except BaseException as exc:
            return Result(
                "<eval>",
                "error",
                perf_counter() - started,
                error=f"{type(exc).__name__}: {exc}",
                output=buf.getvalue(),
            )
        return Result(
            "<eval>",
            "ran",
            perf_counter() - started,
            value=brief(value),
            output=buf.getvalue(),
        )

    # ---- execution

    def _execute(self, cid: str) -> Result:
        """Exec one cell against the namespace.

        Self-references read the last committed version, because defs are
        not popped before exec; on failure the namespace is restored from
        that committed version, so a crash leaves no half-written state.
        Cell stdout/stderr is captured into the Result, never leaked.
        """
        cell = self.cells[cid]
        prior = {n: self.ns.get(n, _MISSING) for n in cell.defs}
        buf = io.StringIO()
        started = perf_counter()
        try:
            with redirect_stdout(buf), redirect_stderr(buf):
                exec(cell.body, self.ns)
                value = eval(cell.tail, self.ns) if cell.tail else None
        except BaseException as exc:
            for n, v in prior.items():
                if v is _MISSING:
                    self.ns.pop(n, None)
                else:
                    self.ns[n] = v
            cell.error = exc
            return Result(
                cid,
                "error",
                perf_counter() - started,
                error=f"{type(exc).__name__}: {exc}",
                output=buf.getvalue(),
            )
        cell.error = None
        self._versions[cid] = {n: self.ns[n] for n in cell.defs if n in self.ns}
        return Result(
            cid,
            "ran",
            perf_counter() - started,
            value=brief(value),
            output=buf.getvalue(),
        )

    def run(self) -> list[Result]:
        if not self.pending:
            return []
        results: list[Result] = []
        failed: set[str] = set()
        skip: set[str] = set()

        for cid in self.topo(self.pending):
            if cid in skip:
                continue
            result = self._execute(cid)
            results.append(result)
            if result.status == "error":
                failed.add(cid)
                skip |= self.descendants(cid)

        self.pending = failed | skip
        return results

    def rerun(self, cid: str) -> list[Result]:
        """Force a re-run of one cell and everything downstream.

        On a stateful cell (a self-edge) this *advances* the accumulator
        rather than refreshing it — by design.
        """
        if cid not in self.cells:
            raise KeyError(f"no cell {cid!r}")
        self.pending |= {cid} | self.descendants(cid)
        return self.run()

    def run_all(self, restart: bool = True) -> list[Result]:
        """Evaluate everything from the top. With restart (the default)
        the namespace and the version store are dropped first, so this is
        a true replay: the notebook is a program, not a transcript."""
        if restart:
            self.ns = {"__builtins__": builtins}
            self._versions.clear()
        self.pending = set(self.cells)
        return self.run()

    # ---- introspection

    def describe(self) -> dict:
        """The view the agent gets back, instead of a scrolling transcript."""
        return {
            "cells": [
                {
                    "id": cid,
                    "name": self.cells[cid].name,
                    "defines": sorted(self.cells[cid].defs),
                    "depends_on": sorted(self.parents(cid)),
                    "stateful": self.stateful(cid),
                    "failing": self.cells[cid].error is not None,
                }
                for cid in self.topo()
            ],
            "names": {cid: c.name for cid, c in self.cells.items() if c.name},
            "globals": {
                n: brief(self.ns[n]) for n in sorted(self.provider) if n in self.ns
            },
            "pending": sorted(self.pending),
            "failing": sorted(cid for cid, c in self.cells.items() if c.error),
        }


# ------------------------------------------------------------------ demo

if __name__ == "__main__":
    nb = Notebook(seed=7)

    imports, _ = nb.add("import math", name="imports")
    data, _ = nb.add("radius = 2", name="data")
    derived, _ = nb.add("area = math.pi * radius ** 2", name="derived")
    helper, _ = nb.add(
        "def describe():\n    return f'r={radius} area={area:.2f}'", name="helper"
    )
    report, results = nb.add("describe()", name="report")

    print("graph (insertion order, ids generated):")
    for cid in nb.topo():
        cell = nb.cells[cid]
        print(
            f"  {cid} {str(cell.name):9} defs={sorted(cell.defs)!s:24} "
            f"refs={sorted(cell.refs)}"
        )

    print("\nedit `data` -> everything downstream recomputes:")
    for r in nb.set(data, "radius = 10"):
        print(f"  {r.cell} {r.status:6} {r.value!r}")

    print("\nstateful cell (versioned namespace):")
    acc, _ = nb.add(
        "try:\n    count = count + 1\nexcept NameError:\n    count = None",
        name="counter",
    )
    nb.run()
    print(f"  after first run:  count={nb.ns['count']}")
    nb.set(
        acc,
        "try:\n"
        "    count = (0 if count is None else count + 1)\n"
        "except NameError:\n"
        "    count = 0",
    )
    nb.rerun(acc)
    print(f"  after rerun:      count={nb.ns['count']}")
    nb.run_all()
    print(f"  after run_all:    count={nb.ns['count']}  (replay converges)")

    print("\ndelete `data` -> its globals are retracted, dependents fail:")
    for r in nb.delete(data):
        print(f"  {r.cell} {r.status:6} {r.error or r.value!r}")
    print(f"  'radius' still in namespace? {'radius' in nb.ns}")
    print(f"  still pending: {sorted(nb.pending)}")

    print("\nguards:")
    try:
        nb.add("area = 0", run=False)
    except MultipleDefinitionError as e:
        print(f"  {e}")
    try:
        a, _ = nb.add("p = q", run=False)
        nb.add("q = p", run=False)
    except CycleError as e:
        print(f"  {e}")
    try:
        nb.add("radius = 99", name="data", run=False)
    except DuplicateNameError as e:
        print(f"  {e}")
