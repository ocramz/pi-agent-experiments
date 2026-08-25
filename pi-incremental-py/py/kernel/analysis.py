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
3. **The survey** (`_survey_bindings`). Three AST facts symtable gets
   wrong or cannot see: comprehension targets that PEP 709 inlined into
   the enclosing table, names removed by `del`, and whether the cell
   imports anything (an edge from the synthetic environment root).
4. **Correction two.** A trailing display expression reads back what the
   body just wrote, and symtable cannot tell `total = 1` followed by a
   bare `total` from `total = total + 1`. Only a read in the body proper,
   of a name the body is certain to have bound by then, is a read of the
   *previous* committed value.

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
_NAMED_BINDERS = (
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.ClassDef,
    ast.ExceptHandler,  # the only one whose `name` may be None
)

# Nodes that open a namespace of their own. A binding inside one is local
# to it unless a `global` statement says otherwise.
_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)


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
    defs -= survey.phantom | survey.deleted
    refs -= survey.phantom

    # Correction two: a trailing display expression reads back what the
    # body just wrote, so a self-ref that appears nowhere but the tail is
    # not a temporal dependency at all.
    body = _body_without_tail(tree)
    refs -= ((defs & refs) - _reads_in_body(body)) & _certainly_bound(body)

    return Analysis(frozenset(defs), frozenset(refs), survey.imports)


def tail_expression(tree: ast.Module) -> ast.Expr | None:
    """The cell's trailing display expression, if it ends in one.

    The one place that decides what counts as a tail, so the analysis and
    `Cell.of`'s compilation cannot drift apart about it.
    """
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        return tree.body[-1]
    return None


def _body_without_tail(tree: ast.Module) -> list[ast.stmt]:
    """A cell's statements with the trailing display expression split off."""
    return tree.body[:-1] if tail_expression(tree) is not None else tree.body


def _survey_bindings(tree: ast.AST) -> Survey:
    """One walk, three corrections to what `symtable` reports.

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
    return Survey(frozenset(phantom - bound), frozenset(deleted), imports)


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


def _reads_in_body(stmts: list[ast.stmt]) -> set[str]:
    """Every name the body can read: Name loads, plus augmented targets.

    Position-blind on purpose. `x = 1` followed by a bare `x` as a
    *non-final* statement counts as a read even though it cannot see the
    previous value, because the alternative is a definite-assignment
    analysis for a shape nobody writes, and the error is in the safe
    direction — an extra dependency is what happens today.
    """
    reads: set[str] = set()
    for stmt in stmts:
        for node in ast.walk(stmt):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                reads.add(node.id)
            elif isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name):
                reads.add(node.target.id)
    return reads


def _certainly_bound(stmts: list[ast.stmt]) -> set[str]:
    """Names the body is *guaranteed* to bind before the tail runs.

    Only the body's own top level counts. A binding inside an `if`, a
    `try`, or a loop may not happen, and then the trailing expression
    really does read the previous committed value after all — so
    `if flag:\\n    x = 1\\nx` keeps its self-ref. Every case this is unsure
    about keeps the ref, which is exactly the old behaviour: the analysis
    can only ever drop a dependency it has proved spurious.
    """
    bound: set[str] = set()
    for stmt in stmts:
        if isinstance(stmt, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            if isinstance(stmt, ast.AnnAssign) and stmt.value is None:
                continue  # `x: int` annotates without binding
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            for target in targets:
                for node in ast.walk(target):
                    if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                        bound.add(node.id)
        elif isinstance(stmt, _NAMED_BINDERS) and stmt.name:
            bound.add(stmt.name)
        elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
            bound |= {(a.asname or a.name).split(".")[0] for a in stmt.names}
    return bound
