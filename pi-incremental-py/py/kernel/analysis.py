"""Static analysis: what a cell defines, and what it reads.

This module produces the cell dependency graph the graph comes from :
cells never declare anything, so `defs` and `refs` are recovered from the
source alone.

The `analyze_source` analysis pipeline is four passes over the AST and the `symtable`:

1. **Base pass.** `symtable` classifies every name in the module scope
   and in each nested scope. It is used instead of a hand-rolled AST walk
   to respect Python scoping that are not explicit in the syntax : parameters,
   comprehension variables and class attributes are *not* global reads,
   while a bare name inside a nested function usually is.
2. **Correction one** (`_augmented_reads`). symtable reports which names
   are assigned and which are referenced, never in what order, and an
   augmented assignment leaves no Load node at all — so `x += 1` has to
   be re-read off the AST or the cell never depends on its own previous
   value.
3. **The survey** (`_survey_bindings`). Four AST facts symtable gets
   wrong or cannot see: comprehension targets that PEP 709 inlined into
   the enclosing table, names removed by `del`, names bound in a position
   Python guarantees leaves nothing behind, and whether the cell imports
   anything (an edge from the synthetic environment root).
4. **Correction two** (`_shadowed_reads`). symtable cannot tell
   `total = 1` followed by a bare `total` from `total = total + 1`, nor
   `with open(p) as f: f.read()` from a read of an incoming `f`. A load
   the cell has provably already bound is not a read of the *previous*
   committed value.

Convention : Every correction can only ever *drop* a dependency it has proved
spurious, so an unsure case keeps the ref and the cell re-runs once too
often rather than once too seldom.
"""

from __future__ import annotations

import ast
import symtable
from dataclasses import dataclass

_COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)

# Statements that bind a name through an attribute rather than a Name node.
# `ExceptHandler` is deliberately absent: its name is *transient* (Python
# unbinds it at the end of the block), so `_survey_bindings` routes it
# there instead of into `bound`.
_NAMED_BINDERS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)

# Nodes that open a namespace of their own. A binding inside one is local
# to it unless a `global` statement says otherwise.
_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)

# Statements that bind a name *for their own body*: the body cannot run
# before the binding happened, so a read of the target in there is a read
# of this cell's binding and never of the incoming namespace.
_WITHS = (ast.With, ast.AsyncWith)
_FORS = (ast.For, ast.AsyncFor)


@dataclass(frozen=True)
class Analysis:
    """Everything the graph and the cache key need from one cell's source.

    `refs` means *globals read from the incoming namespace* — what the
    cell's result actually depends on. Builtin names stay in it (the
    graph, which knows the providers, decides whether `len` is a real
    edge because some cell shadows it), and so do self-defs when the read
    is genuinely temporal: `x = x + 1` reads the last committed x.
    """

    defs: frozenset[str]
    refs: frozenset[str]
    imports: bool  # edge from the synthetic environment root


@dataclass(frozen=True)
class Survey:
    """The AST facts symtable reports wrongly, or not at all."""

    phantom: frozenset[str]  # comprehension targets that never bind (PEP 709)
    deleted: frozenset[str]  # `del x` — symtable still calls it assigned
    transient: frozenset[str]  # bound, then unbound again by the language
    imports: bool


def analyze(src: str) -> tuple[frozenset[str], frozenset[str]]:
    """Return (defs, refs) for one cell. See `analyze_source`."""
    analysis = analyze_source(src, ast.parse(src))
    return analysis.defs, analysis.refs


def analyze_source(src: str, tree: ast.Module) -> Analysis:
    """Run the four-stage pipeline described at the top of this module.

    Takes the parsed tree as well as the source so that a caller which
    has to parse anyway — `Cell.of`, which also compiles — parses once.
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

    # Correction one: an augmented assignment is a read symtable never
    # reports, because it binds through a Store with no Load node.
    refs |= _augmented_reads(tree)

    survey = _survey_bindings(tree)
    defs -= survey.phantom | survey.deleted | survey.transient
    refs -= survey.phantom

    # Correction two: a load of a name this cell has provably already
    # bound reads back its own binding, not the incoming namespace.
    refs -= _shadowed_reads(tree)

    return Analysis(frozenset(defs), frozenset(refs), survey.imports)


def tail_expression(tree: ast.Module) -> ast.Expr | None:
    """The cell's trailing display expression, if it ends in one.

    The one place that decides what counts as a tail, so the analysis and
    `Cell.of`'s compilation cannot drift apart about it.
    """
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        return tree.body[-1]
    return None


def _survey_bindings(tree: ast.AST) -> Survey:
    """One walk, four corrections to what `symtable` reports.

    *phantom*: since PEP 709 (Python 3.12) comprehensions are inlined, so
    `for x in ...` clauses show up in the enclosing symbol table as
    assigned even though they never bind at runtime. A comprehension
    variable is only a phantom if nothing else binds that name — `r = 1`
    followed by `[... for r in rows]` really does bind r.

    *deleted*: `del x` does not define x; symtable marks it assigned.

    *transient*: two positions where the language itself takes the name
    back. `except E as e` is unbound at the end of the handler, and a
    valueless `x: int` annotates without ever binding. symtable calls
    both assigned, and a def that cannot be in the namespace afterwards
    is a global claim the cell can never honour. Same nothing-else-binds
    guard as *phantom*, for the same reason: `e = 1` next to an
    `except E as e` really does bind e.

    Binding positions are read off `Name.ctx` rather than enumerated by
    statement type: `Store` is exactly the set of them, and it correctly
    declines to call `d` or `k` a binding in `d[k] = v`.
    """
    phantom: set[str] = set()
    transient: set[str] = set()
    excused: set[int] = set()  # Store nodes that do not count as bindings
    for node in ast.walk(tree):
        if isinstance(node, _COMPREHENSIONS):
            for gen in node.generators:
                for name in ast.walk(gen.target):
                    if isinstance(name, ast.Name):
                        phantom.add(name.id)
                        excused.add(id(name))
        elif (
            isinstance(node, ast.AnnAssign)
            and node.value is None
            and isinstance(node.target, ast.Name)
        ):
            transient.add(node.target.id)
            excused.add(id(node.target))

    bound: set[str] = set()
    deleted: set[str] = set()
    imports = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Del):
                deleted.add(node.id)
            elif isinstance(node.ctx, ast.Store) and id(node) not in excused:
                bound.add(node.id)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            transient.add(node.name)
        elif isinstance(node, _NAMED_BINDERS) and node.name:
            bound.add(node.name)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            imports = True
            bound |= {(a.asname or a.name).split(".")[0] for a in node.names}
    return Survey(
        frozenset(phantom - bound),
        frozenset(deleted),
        frozenset(transient - bound),
        imports,
    )


def _augmented_reads(tree: ast.Module) -> set[str]:
    """Globals bound by `x += 1`, which reads x as surely as it writes it.

    symtable reports an augmented assignment as assigned and *not*
    referenced — there is no Load node anywhere — so without this the name
    never reaches `refs` and the cell does not depend on its own previous
    value. Every other read-write form leaves a Load behind and symtable
    already sees it: `x[0] = 1`, `x.attr = 1`, `for x in x`, `(x := x + 1)`.

    Nested scopes count only for names they declare `global`. A function's
    own `n += 1` binds a local, and claiming it as a read would invent a
    dependency on an unrelated global that happens to share the name.
    """
    names: set[str] = set()
    # (node, names that reach the module namespace from here)
    stack: list[tuple[ast.AST, frozenset[str] | None]] = [(tree, None)]
    while stack:
        node, scope_globals = stack.pop()
        if isinstance(node, ast.AugAssign):
            target = node.target
            # None marks module level, where every binding is global.
            if isinstance(target, ast.Name) and (
                scope_globals is None or target.id in scope_globals
            ):
                names.add(target.id)
        for child in ast.iter_child_nodes(node):
            if isinstance(child, _SCOPES):
                stack.append((child, _declared_global(child)))
            else:
                stack.append((child, scope_globals))
    return names


def _declared_global(scope: ast.AST) -> frozenset[str]:
    """Names a `global` statement lifts out of one scope, that scope only."""
    declared: set[str] = set()
    stack = list(ast.iter_child_nodes(scope))
    while stack:
        node = stack.pop()
        if isinstance(node, ast.Global):
            declared |= set(node.names)
        if isinstance(node, _SCOPES):
            continue  # a nested scope declares for itself
        stack.extend(ast.iter_child_nodes(node))
    return frozenset(declared)


def _binder_targets(node: ast.AST) -> tuple[set[str], list[ast.stmt]]:
    """Names a `for`/`with`/`except` binds, and the body that sees them.

    Empty for anything else. A `for`'s `orelse` is included because it
    runs after the loop, where the target — if the loop ran at all — is
    whatever the last iteration bound.
    """
    if isinstance(node, _FORS):
        return _stored_names(node.target), [*node.body, *node.orelse]
    if isinstance(node, _WITHS):
        names: set[str] = set()
        for item in node.items:
            if item.optional_vars is not None:
                names |= _stored_names(item.optional_vars)
        return names, list(node.body)
    if isinstance(node, ast.ExceptHandler) and node.name:
        return {node.name}, list(node.body)
    return set(), []


def _stored_names(target: ast.AST) -> set[str]:
    """Names an assignment target binds, tuple-unpacking included."""
    return {
        node.id
        for node in ast.walk(target)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)
    }


def _shadowed_load_ids(tree: ast.Module) -> set[int]:
    """Loads that a `for`/`with`/`except` in scope has already bound.

    `with open(p) as f:` followed by `f.read()` in its body is the shape
    this exists for: symtable sees f assigned *and* referenced, exactly as
    in `x = x + 1`, so without this the cell keys on the *previous* f —
    a closed file handle, which has no digest, which makes the whole key
    None and the cell uncacheable forever.

    Nested scopes are skipped: a `lambda: r` inside a loop body reads r
    when it is *called*, which is not this cell's business, so that load
    keeps its reference.
    """
    shadowed: set[int] = set()
    for node in ast.walk(tree):
        names, body = _binder_targets(node)
        if not names:
            continue
        stack: list[ast.AST] = list(body)
        while stack:
            inner = stack.pop()
            if isinstance(inner, _SCOPES):
                continue
            if (
                isinstance(inner, ast.Name)
                and isinstance(inner.ctx, ast.Load)
                and inner.id in names
            ):
                shadowed.add(id(inner))
            stack.extend(ast.iter_child_nodes(inner))
    return shadowed


def _shadowed_reads(tree: ast.Module) -> frozenset[str]:
    """Names every load of which reads a binding this cell already made.

    Two ways a load is proved not to see the incoming namespace: it sits
    inside the body of a binder that binds it (`_shadowed_load_ids`), or
    a preceding top-level statement is certain to have bound it
    (`_certainly_bound`). The second subsumes the trailing display
    expression — `total = 1` followed by a bare `total` — since the tail
    is just the last statement, and it also settles `flag = False`
    followed by `if flag:`.

    Only names actually seen loaded are returned, so a reference the walk
    cannot account for keeps its dependency: the analysis may only ever
    drop one it has proved spurious.
    """
    shadowed = _shadowed_load_ids(tree)
    loaded: set[str] = set()
    incoming: set[str] = set()
    bound: set[str] = set()
    for stmt in tree.body:
        for node in ast.walk(stmt):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                loaded.add(node.id)
                if id(node) not in shadowed and node.id not in bound:
                    incoming.add(node.id)
            elif isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name):
                # Binds through a Store with no Load node; see `_augmented_reads`.
                loaded.add(node.target.id)
                if node.target.id not in bound:
                    incoming.add(node.target.id)
        bound |= _certainly_bound([stmt])
    return frozenset(loaded - incoming)


def _certainly_bound(stmts: list[ast.stmt]) -> set[str]:
    """Names these statements are *guaranteed* to have bound afterwards.

    Only the cell's own top level counts. A binding inside an `if`, a
    `try`, or a loop may not happen, and then a later read really does
    see the previous committed value after all — so `if flag:\\n    x = 1\\nx`
    keeps its self-ref, and a `for` target is absent here because an empty
    iterable binds nothing. Every case this is unsure about keeps the ref:
    the analysis can only ever drop a dependency it has proved spurious.

    A `with` target *is* counted: control only reaches the next statement
    if the block completed, and it cannot have completed without binding.
    """
    bound: set[str] = set()
    for stmt in stmts:
        if isinstance(stmt, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            if isinstance(stmt, ast.AnnAssign) and stmt.value is None:
                continue  # `x: int` annotates without binding
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            for target in targets:
                bound |= _stored_names(target)
        elif isinstance(stmt, _WITHS):
            for item in stmt.items:
                if item.optional_vars is not None:
                    bound |= _stored_names(item.optional_vars)
        elif isinstance(stmt, _NAMED_BINDERS) and stmt.name:
            bound.add(stmt.name)
        elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
            bound |= {(a.asname or a.name).split(".")[0] for a in stmt.names}
    return bound
