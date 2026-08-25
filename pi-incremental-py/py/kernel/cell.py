"""A cell, and what happens when one runs.

`Cell` is the compiled, analysed definition; it's immutable, so staging can
roll back by restoring a shallow copy of the `cells` dict. `Result` is
what one execution produced, and `Outcome` is that result paired with the
key it ran under. `run_cell` is the only place a cell's code is executed.
"""

from __future__ import annotations

import ast
import builtins
import io
import types
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass
from time import perf_counter

from .analysis import analyze_source, tail_expression
from .values import brief


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
        """Reads something it also defines: a temporal self-edge.

        `refs` has already discounted a trailing display expression's read
        of the body's own binding, so this is the accumulator question and
        not the "mentions its own name" one.
        """
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
        analysis = analyze_source(src, tree)
        tail_node = tail_expression(tree)
        tail_expr = None
        if tail_node is not None:
            tree.body.pop()
            tail_expr = ast.Expression(tail_node.value)
            ast.copy_location(tail_expr, tail_expr.body)
        body = compile(tree, "<cell>", "exec")
        tail = compile(tail_expr, "<cell>", "eval") if tail_expr is not None else None
        return cls(
            src, name, analysis.defs, analysis.refs, body, tail, analysis.imports
        )


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


def fresh_namespace() -> dict[str, object]:
    return {"__builtins__": builtins}


def run_cell(cell: Cell, ns: dict, cid: str) -> Result:
    """Run a cell against a namespace and describe what happened.

    NB: uses `exec` and `eval`.

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
