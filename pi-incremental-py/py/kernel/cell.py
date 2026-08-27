"""A cell, and what happens when one runs.

`Cell` is the compiled, analysed definition; it's immutable, so staging can
roll back by restoring a shallow copy of the `cells` dict. `Result` is
what one execution produced, and `Outcome` is that result paired with the
key it ran under. `run_cell` is the only place a cell's code is executed.

It is also the only place the kernel can *watch* a cell. Static analysis
recovers what a cell reads from the namespace, but not what it reads from
the world, and Python has no way to infer the latter: a name blacklist is
defeated by `f = time.time`, by `getattr`, and by any C extension that
opens a socket without mentioning one. So the world is observed instead
of predicted, with an audit hook (PEP 578), and the observations are
split by whether they can be digested:

    a file read   -> a cache-key input; a file has content, so the cell
                     can cache until that content actually changes
    a socket, a
    subprocess    -> the cell is volatile; "the internet" has no digest,
                     so the only sound answer is to always re-run

Everything the hook cannot see — `time.time()` raises no audit event —
is left to the `volatile` flag the author declares.
"""

from __future__ import annotations

import ast
import builtins
import io
import os
import site
import sys
import sysconfig
import types
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass
from time import perf_counter

from .analysis import analyze_source, tail_expression
from .values import brief

# Audit events that mean "this cell touched something with no digest".
# Deliberately not `open`: a path can be digested, so a file read is an
# input rather than a surrender. See `_audit`.
_VOLATILE_EVENTS = frozenset(
    {
        "socket.connect",
        "socket.getaddrinfo",
        "socket.gethostbyname",
        "socket.sethostname",
        "subprocess.Popen",
        "os.system",
        "os.exec",
        "os.spawn",
        "os.posix_spawn",
        "urllib.Request",
        "ftplib.connect",
        "smtplib.connect",
        "imaplib.open",
    }
)

# Reported as an effect so the agent learns *why* a cell stopped caching.
TOO_MANY_READS = "<too-many-reads>"
_MAX_TRACKED_READS = 64

_WRITE_MODES = frozenset("wax+")


def _interpreter_prefixes() -> tuple[str, ...]:
    """Path prefixes whose files are the interpreter's business, not a cell's.

    `import json` really does open files — a dozen `.pyc` under the stdlib
    — and without this every importing cell would acquire a dozen tracked
    inputs, or trip the count guard and stop caching altogether. Those
    files are already covered by `env_digest`, which moves when anything
    is installed or upgraded, so tracking them again would be redundant
    as well as ruinous.

    Both `sys.prefix` and `sys.base_prefix` are needed: inside a venv the
    stdlib lives under the base, and site-packages under the venv.
    """
    roots = {sys.prefix, sys.base_prefix, sysconfig.get_paths()["stdlib"]}
    for getter in (site.getsitepackages, site.getusersitepackages):
        try:
            found = getter()
        except Exception:  # not available under every embedding
            continue
        roots.update([found] if isinstance(found, str) else found)
    prefixes = set()
    for root in filter(None, roots):
        prefixes.add(os.path.join(root, ""))
        prefixes.add(os.path.join(os.path.realpath(root), ""))
    return tuple(prefixes)


_PREFIXES = _interpreter_prefixes()

# The recorder the audit hook writes into. Module-level because
# `sys.addaudithook` cannot be removed once installed, so there is
# exactly one hook for the process and `run_cell` gates it with a flag.
_watching = False
_reads: set[str] = set()
_effects: set[str] = set()


def _audit(event: str, args: tuple) -> None:
    """The one audit hook. Must be O(1), and must never raise.

    An exception from an audit hook aborts the operation being audited,
    so a bug here would not merely mis-record a cell — it would break
    every `open` in the process. Hence the blanket except.

    The watch flag is process-wide, so a cell that leaves a background
    thread running can have that thread's reads charged to whichever cell
    runs next. Mis-attribution only ever *adds* an input or a demotion,
    which costs a re-run and cannot produce a stale hit.
    """
    if not _watching:
        return
    try:
        if event in _VOLATILE_EVENTS:
            _effects.add(event)
        elif event == "open":
            path, mode = args[0], args[1]
            # `os.fdopen` passes an int; a write is not an input, since a
            # cell does not depend on what it itself produced.
            if not isinstance(path, str) or (mode and _WRITE_MODES & set(mode)):
                return
            if not path.startswith(_PREFIXES):
                _reads.add(path)
    except Exception:
        pass


sys.addaudithook(_audit)


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
    volatile: bool = False  # declared: reads something with no digest

    @property
    def stateful(self) -> bool:
        """Reads something it also defines: a temporal self-edge.

        `refs` has already discounted a trailing display expression's read
        of the body's own binding, so this is the accumulator question and
        not the "mentions its own name" one.
        """
        return bool(self.refs & self.defs)

    @classmethod
    def of(cls, src: str, name: str | None, volatile: bool = False) -> Cell:
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
            src,
            name,
            analysis.defs,
            analysis.refs,
            body,
            tail,
            analysis.imports,
            volatile,
        )


@dataclass
class Result:
    """The one currency of execution.

    `reads` and `effects` are what the audit hook saw. They are tuples
    rather than sets because `protocol` puts a Result on the wire with
    `asdict`, and a set is not JSON.
    """

    cell: str
    status: str  # ran | cached | error
    seconds: float
    value: str | None = None
    error: str | None = None
    output: str = ""
    reads: tuple[str, ...] = ()  # files read: cache-key inputs
    effects: tuple[str, ...] = ()  # undigestible: forces volatile


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


def _observed() -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Close the watch window and report what the cell touched.

    The count guard is here rather than in the notebook because this is
    where the cost is known. Stat-gating makes each tracked file about
    one `stat` per key computation, so sixty-four is cheap — but a cell
    that walks a directory tree would otherwise put ten thousand of them
    into every subsequent key. Discarding the set and calling the cell
    volatile is the honest degradation: slower, never wrong.
    """
    global _watching
    _watching = False
    effects = set(_effects)
    reads: tuple[str, ...] = ()
    if len(_reads) > _MAX_TRACKED_READS:
        effects.add(TOO_MANY_READS)
    else:
        reads = tuple(sorted(_reads))
    return reads, tuple(sorted(effects))


def run_cell(cell: Cell, ns: dict, cid: str) -> Result:
    """Run a cell against a namespace and describe what happened.

    NB: uses `exec` and `eval`.

    stdout/stderr are captured rather than leaked: on the JSON-lines
    protocol a stray print would corrupt the wire. A trailing expression
    was split off at compile time and becomes the display value.

    The audit hook records what the cell touched while it ran; a cell
    that *failed* still reports what it touched, because it opened those
    files and reached that socket before it raised.
    """
    global _watching
    buf = io.StringIO()
    _reads.clear()
    _effects.clear()
    _watching = True
    started = perf_counter()
    try:
        with redirect_stdout(buf), redirect_stderr(buf):
            exec(cell.body, ns)
            value = eval(cell.tail, ns) if cell.tail else None
    except BaseException as exc:
        seconds = perf_counter() - started
        reads, effects = _observed()
        return Result(
            cid,
            "error",
            seconds,
            error=f"{type(exc).__name__}: {exc}",
            output=buf.getvalue(),
            reads=reads,
            effects=effects,
        )
    seconds = perf_counter() - started
    reads, effects = _observed()
    return Result(
        cid,
        "ran",
        seconds,
        value=brief(value),
        output=buf.getvalue(),
        reads=reads,
        effects=effects,
    )
