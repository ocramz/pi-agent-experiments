"""A minimal reactive notebook kernel with content-addressed caching.

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
with an empty namespace; the blessed accumulator idiom is

    try:
        x = x + 1
    except NameError:
        x = None

`None` is the neutral "nothing yet" — the except branch exists so the
cell is meaningful from scratch; pick whatever initial value the cell
should start from. This converges between incremental runs and full
replays.

Caching: a cell's key is a hash of its source plus the value-digests of
every global it reads — including its own defs, so a stateful cell keys
on the previous version and honestly re-runs. Key unchanged -> skip.
This gives *early cutoff* for free: if a re-run produces the same value,
downstream keys don't move and nothing downstream re-runs.

The environment is a tracked input too. Installing a package mid-session
works, but a *cached* cell can silently encode the old environment:

    try:
        import cowsay
        have_cowsay = True
    except ImportError:
        have_cowsay = False

Its source never changes and its inputs never change, so its key never
moves, so it reports False forever after you install the package. Fix:
the installed distribution set is a synthetic root node of the DAG, and
cells that import anything depend on it. The digest is deliberately
all-or-nothing: any install invalidates every importing cell, which is
coarse but never wrong.

The kernel also supports `eval_src`: evaluate a snippet in the live
namespace without creating a cell (no defs recorded, no graph impact) —
used by human-facing `/py` interactions.
"""

from __future__ import annotations

import ast
import builtins
import copy
import hashlib
import heapq
import importlib.metadata
import io
import pickle
import random
import symtable
import time
import types
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass
from time import perf_counter

_MISSING = object()

_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"  # RFC 4648 base32, lowercase
_ID_LENGTH = 6


class CycleError(Exception):
    """Cells form a dependency cycle; no valid execution order exists."""


class MultipleDefinitionError(Exception):
    """Two cells bind the same global, so the graph would be ambiguous."""


class DuplicateNameError(Exception):
    """Two cells carry the same display name."""


# --------------------------------------------------------------- digests


def _hash(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.blake2b(data, digest_size=12).hexdigest()


def _code_fingerprint(code: types.CodeType) -> tuple:
    """Structure of a code object, recursively.

    `repr` of a code object embeds its memory address, so a function
    holding a nested `def` or `lambda` would hash differently in every
    process. Keys are lineage (see docs/persistence.md), so they have to
    survive a restart.
    """
    return (
        code.co_code,
        code.co_names,
        code.co_varnames,
        tuple(
            _code_fingerprint(c) if isinstance(c, types.CodeType) else repr(c)
            for c in code.co_consts
        ),
    )


# Markers for the two structural cases that have no content of their own.
# Fixed strings, because they end up in a key that has to be reproducible.
_CYCLE = "<cycle>"
_EMPTY_CELL = "<empty-cell>"


def digest(obj: object) -> str | None:
    """Stable content digest, or None meaning 'assume always changed'.

    This answers one question: if a cell reads this object again, could
    its result differ? Four rules, in priority order.

    1. Sound. Equal digests must mean interchangeable. A false "same" is
       a wrong answer that surfaces as a cell reporting `cached` when it
       should have re-run, so this is the rule that cannot be traded.
    2. Process-stable. Keys are lineage (docs/persistence.md), so the
       same content must digest the same way in a fresh interpreter.
    3. Total. Never raises; unknown is None, which is the safe direction.
    4. Cheap. It runs once per ref, per key computation.

    Rule 1 is why functions are decomposed rather than hashed by code
    alone: two closures from one `def` differ only in what they captured.
    Rule 2 is why sets are canonicalised rather than pickled: pickle
    walks them in iteration order, which is hash-randomised.
    """
    return _digest(obj, frozenset())


def _digest(obj: object, seen: frozenset[int]) -> str | None:
    if isinstance(obj, types.ModuleType):
        # Include the version: a bare name is blind to upgrades, so early
        # cutoff would stop propagating after `pip install -U`.
        try:
            version = importlib.metadata.version(obj.__name__.split(".")[0])
        except Exception:
            version = getattr(obj, "__version__", "?")
        return f"module:{obj.__name__}:{version}"
    if isinstance(obj, (types.FunctionType, types.LambdaType)):
        if id(obj) in seen:
            return _CYCLE
        return _digest_function(obj, seen | {id(obj)})
    # Exact types only: a subclass may carry state of its own, and pickle
    # is the one that knows about it.
    if type(obj) in (set, frozenset):
        if id(obj) in seen:
            return _CYCLE
        return _digest_set(obj, seen | {id(obj)})
    try:
        return _hash(pickle.dumps(obj, protocol=4))
    except Exception:
        return None  # sockets, file handles, live models, ...


def _digest_function(fn: types.FunctionType, seen: frozenset[int]) -> str | None:
    """Code, captures and defaults — everything that decides what it does.

    Pickle would serialise a function *by name*, so an edited body would
    hash identically; the code fingerprint fixes that. But the code is
    only part of it. `make(3)` and `make(4)` return closures sharing one
    code object and differing only in a captured cell, so a code-only
    digest calls them equal and every dependent silently keeps a stale
    value. Defaults are the same story with different storage.

    Sections are labelled so that a capture and a default holding the
    same value cannot produce the same digest by rearrangement.
    """
    parts = ["code:" + repr(_code_fingerprint(fn.__code__))]

    for cell in fn.__closure__ or ():
        try:
            captured = cell.cell_contents
        except ValueError:
            # A cell not yet filled — a forward reference during class or
            # mutually-recursive definition. A state, not a failure.
            parts.append("closure:" + _EMPTY_CELL)
            continue
        digested = _digest(captured, seen)
        if digested is None:
            return None
        parts.append("closure:" + digested)

    for default in fn.__defaults__ or ():
        digested = _digest(default, seen)
        if digested is None:
            return None
        parts.append("default:" + digested)

    kwdefaults = fn.__kwdefaults__ or {}
    for name in sorted(kwdefaults):
        digested = _digest(kwdefaults[name], seen)
        if digested is None:
            return None
        parts.append(f"kwdefault:{name}={digested}")

    return _hash("\x00".join(parts))


def _digest_set(value: set | frozenset, seen: frozenset[int]) -> str | None:
    """Order-free digest of a set.

    `pickle.dumps` emits members in iteration order, and for str or bytes
    members that order follows PYTHONHASHSEED — so the same set digests
    differently in two processes and every dependent looks invalidated
    after a restart. Sorting the members' *digests* (not the members)
    gives a canonical order that works for unorderable and mixed types.
    """
    digested = []
    for element in value:
        element_digest = _digest(element, seen)
        if element_digest is None:
            return None
        digested.append(element_digest)
    kind = "frozenset" if isinstance(value, frozenset) else "set"
    return _hash(kind + ":" + "\x00".join(sorted(digested)))


_env_digest: str | None = None


def env_digest(refresh: bool = False) -> str:
    """Hash of every installed distribution and its version.

    Cached: scanning the metadata of every distribution is far too slow
    to repeat per notebook, and the set only moves when we move it.
    """
    global _env_digest
    if _env_digest is None or refresh:
        names = sorted(
            f"{dist.metadata['Name']}=={dist.version}"
            for dist in importlib.metadata.distributions()
            if dist.metadata["Name"]
        )
        _env_digest = _hash("\n".join(names))
    return _env_digest


# --------------------------------------------------------------- analysis

_COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)

# Statements that bind a name through an attribute rather than a Name node.
_NAMED_BINDERS = (
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.ClassDef,
    ast.ExceptHandler,  # the only one whose `name` may be None
)


def _survey(tree: ast.AST) -> tuple[set[str], set[str], bool]:
    """One walk, three corrections to what `symtable` reports.

    Returns (phantom, deleted, imports).

    *phantom*: since PEP 709 (Python 3.12) comprehensions are inlined, so
    `for x in ...` clauses show up in the enclosing symbol table as
    assigned even though they never bind at runtime. A comprehension
    variable is only a phantom if nothing else binds that name — `r = 1`
    followed by `[... for r in rows]` really does bind r.

    *deleted*: `del x` does not define x; symtable marks it assigned.

    Binding positions are read off `Name.ctx` rather than enumerated by
    statement type: `Store` is exactly the set of them, and it correctly
    declines to call `d` or `k` a binding in `d[k] = v`.
    """
    phantom: set[str] = set()
    inside_comprehension: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, _COMPREHENSIONS):
            for gen in node.generators:
                for name in ast.walk(gen.target):
                    if isinstance(name, ast.Name):
                        phantom.add(name.id)
                        inside_comprehension.add(id(name))

    bound: set[str] = set()
    deleted: set[str] = set()
    imports = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            phantom_target = id(node) in inside_comprehension
            if isinstance(node.ctx, ast.Del):
                deleted.add(node.id)
            elif isinstance(node.ctx, ast.Store) and not phantom_target:
                bound.add(node.id)
        elif isinstance(node, _NAMED_BINDERS) and node.name:
            bound.add(node.name)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            imports = True
            bound |= {(a.asname or a.name).split(".")[0] for a in node.names}
    return phantom - bound, deleted, imports


def _analyze(src: str, tree: ast.AST) -> tuple[frozenset[str], frozenset[str], bool]:
    """Return (defs, refs, imports) for one cell.

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

    phantom, deleted, imports = _survey(tree)
    defs -= phantom | deleted
    refs -= phantom
    return frozenset(defs), frozenset(refs), imports


def analyze(src: str) -> tuple[frozenset[str], frozenset[str]]:
    """Return (defs, refs) for one cell. See `_analyze`."""
    defs, refs, _ = _analyze(src, ast.parse(src))
    return defs, refs


def brief(value: object, limit: int = 120) -> str:
    """One-line value summary. Agents need shape, not contents."""
    if value is None:
        return "None"
    try:
        size = value.shape  # type: ignore[attr-defined]  # numpy, pandas, torch
        return f"{type(value).__name__}{tuple(size)}"
    except (AttributeError, TypeError):
        pass
    try:
        return f"{type(value).__name__}({len(value)})"  # type: ignore[arg-type]
    except TypeError:
        pass
    text = repr(value)
    return text if len(text) <= limit else text[:limit] + "..."


# ------------------------------------------------------------------ types


@dataclass(frozen=True)
class Cell:
    """A cell's definition. Immutable, so staging can roll back by
    restoring a shallow copy of the `cells` dict."""

    src: str
    name: str | None  # display metadata only; never a lookup key
    defs: frozenset[str]
    refs: frozenset[str]
    body: types.CodeType
    tail: types.CodeType | None
    imports: bool  # edge from the synthetic environment root

    @property
    def stateful(self) -> bool:
        """Reads something it also defines: a temporal self-edge."""
        return bool(self.refs & self.defs)

    @classmethod
    def of(cls, src: str, name: str | None) -> Cell:
        """Analyse and compile in one parse.

        Compiling splits off a trailing expression — the one piece of
        Jupyter semantics worth keeping: if the last statement is an
        expression, evaluate rather than execute it so the cell has a
        display value.
        """
        tree = ast.parse(src)
        defs, refs, imports = _analyze(src, tree)
        tail_expr = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            tail_expr = ast.Expression(tree.body.pop().value)
            ast.copy_location(tail_expr, tail_expr.body)
        body = compile(tree, "<cell>", "exec")
        tail = compile(tail_expr, "<cell>", "eval") if tail_expr is not None else None
        return cls(src, name, defs, refs, body, tail, imports)


@dataclass
class Result:
    """The one currency of execution."""

    cell: str
    status: str  # ran | cached | error
    seconds: float
    value: str | None = None
    error: str | None = None
    output: str = ""


@dataclass(frozen=True)
class Outcome:
    """The last execution of a cell, and the key it ran under.

    One store instead of three (an error flag on the cell, a key dict and
    a value-summary dict), so deleting a cell cannot leave two thirds of
    its history behind.
    """

    key: str
    result: Result


@dataclass(frozen=True)
class Edit:
    """One staged change. `add` with no id has one minted for it."""

    op: str  # add | set | delete
    id: str | None = None
    src: str | None = None
    name: str | None = None

    @classmethod
    def from_json(cls, raw: object) -> Edit:
        match raw:
            case {"op": "add", "src": str(src), **rest}:
                return cls("add", src=src, name=rest.get("name"))
            case {"op": "set", "id": str(cid), "src": str(src)}:
                return cls("set", id=cid, src=src)
            case {"op": "delete", "id": str(cid)}:
                return cls("delete", id=cid)
            case _:
                raise ValueError(f"bad edit {raw!r}")


def _fresh_ns() -> dict[str, object]:
    return {"__builtins__": builtins}


def _exec(cell: Cell, ns: dict, cid: str) -> Result:
    """Run a cell against a namespace and describe what happened.

    stdout/stderr are captured rather than leaked: on the JSON-lines
    protocol a stray print would corrupt the wire. A trailing expression
    was split off at compile time and becomes the display value.
    """
    buf = io.StringIO()
    started = perf_counter()
    try:
        with redirect_stdout(buf), redirect_stderr(buf):
            exec(cell.body, ns)
            value = eval(cell.tail, ns) if cell.tail else None
    except BaseException as exc:
        return Result(
            cid,
            "error",
            perf_counter() - started,
            error=f"{type(exc).__name__}: {exc}",
            output=buf.getvalue(),
        )
    return Result(
        cid,
        "ran",
        perf_counter() - started,
        value=brief(value),
        output=buf.getvalue(),
    )


# --------------------------------------------------------------- notebook


class Notebook:
    # Everything staging has to roll back. `ns` is deliberately absent:
    # staging never executes, so it cannot dirty the namespace.
    _STATE = ("cells", "provider", "parents_of", "kids", "pending", "done", "env")

    def __init__(self, seed: int | None = None) -> None:
        self.cells: dict[str, Cell] = {}  # insertion order = execution tie-break
        self.ns: dict[str, object] = _fresh_ns()
        self.provider: dict[str, str] = {}  # global name -> owning cell id
        self.parents_of: dict[str, frozenset[str]] = {}
        self.kids: dict[str, set[str]] = {}
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

    # ---- graph queries

    def parents(self, cid: str) -> set[str]:
        """Providing cells this cell reads. Self-edges are temporal, not
        topological, so they are excluded; builtin names count only when
        some cell actually provides (shadows) them."""
        return set(self.parents_of[cid])

    def stateful(self, cid: str) -> bool:
        return self.cells[cid].stateful

    def descendants(self, cid: str) -> set[str]:
        seen: set[str] = set()
        stack = [cid]
        while stack:
            for kid in self.kids.get(stack.pop(), ()):
                if kid not in seen:
                    seen.add(kid)
                    stack.append(kid)
        return seen

    def topo(self, subset: set[str] | None = None) -> list[str]:
        """Kahn's algorithm, insertion order as the tie-break so the
        execution order of independent cells never depends on their ids.
        In-degree is counted within `subset` only: parents outside it
        are, by definition, already up to date."""
        ids = set(self.cells) if subset is None else set(subset) & set(self.cells)
        by_index = list(self.cells)
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

    def _rebuild_graph(self) -> None:
        """Recompute provider, adjacency and validate. Final graph only:
        a rename, a split, or interposing a node cannot be expressed as a
        sequence of individually-valid single-cell edits."""
        provider: dict[str, str] = {}
        for cid, cell in self.cells.items():  # insertion order: first definer wins
            for name in cell.defs:
                if name in provider:
                    raise MultipleDefinitionError(
                        f"{name!r} defined by both {provider[name]} and {cid}"
                    )
                provider[name] = cid
        self.provider = provider
        self.parents_of = {
            cid: frozenset(
                provider[n] for n in cell.refs if n in provider and provider[n] != cid
            )
            for cid, cell in self.cells.items()
        }
        kids: dict[str, set[str]] = {cid: set() for cid in self.cells}
        for cid, parents in self.parents_of.items():
            for parent in parents:
                kids[parent].add(cid)
        self.kids = kids
        self.topo()  # cycle check

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

            self._rebuild_graph()

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

        for name in set(saved["provider"]) - set(self.provider):
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
        return _exec(Cell.of(src, None), self.ns, "<eval>")

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
        result = _exec(cell, self.ns, cid)
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
            self.ns = _fresh_ns()
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
