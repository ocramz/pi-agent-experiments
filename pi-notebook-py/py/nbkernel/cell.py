"""A cell, what one execution produced, and the only place code runs.

`Cell` is mutable : there is no staging and no
rollback here, because there is no graph whose consistency an edit could
break. A cell is edited in place and the bookkeeping fields move with it.

Those fields support the staleness mechanism:

    touched_at   the notebook's sequence number when this cell last
                 changed anything a cell below it could have seen — an
                 edit, a run, or a structural change at its position
    ran_at       the sequence number of its last execution, or None

which makes "stale" a one-line predicate the notebook can evaluate without
tracking dependencies. See `Notebook.stale`.
"""

from __future__ import annotations

import io
import traceback
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass, field
from time import perf_counter

from .display import Image, capture
from .source import compile_cell
from .values import brief

__all__ = ["Cell", "Output", "fresh_namespace", "run_cell"]

# Long enough for the frame that actually failed plus its callers, short
# enough that a recursion error does not fill the context window.
_MAX_TRACEBACK = 2000


def fresh_namespace() -> dict[str, object]:
    import builtins

    return {"__builtins__": builtins, "__name__": "__main__"}


@dataclass
class Output:
    """What one execution produced.

    `images` and `notes` are tuples rather than lists because the protocol
    layer puts an Output on the wire with `asdict`, and both have to
    survive that unchanged.
    """

    cell: str
    status: str  # ok | error
    seconds: float
    execution_count: int | None = None
    value: str | None = None
    error: str | None = None
    traceback: str | None = None
    stdout: str = ""
    images: tuple[Image, ...] = ()
    notes: tuple[str, ...] = ()


@dataclass
class Cell:
    id: str
    src: str
    kind: str = "code"
    touched_at: int = 0
    ran_at: int | None = None
    execution_count: int | None = None
    last: Output | None = field(default=None, repr=False)

    @property
    def failing(self) -> bool:
        return self.last is not None and self.last.status == "error"


def _format_traceback(exc: BaseException, skip_frames: int = 1) -> str:
    """The traceback, minus the kernel's own frames.

    `run_cell`'s `exec` call is the first frame of every cell traceback and
    tells the reader nothing, so it is dropped. Because the cell's source
    is registered with linecache under its pseudo-filename, what is left
    shows the offending line.
    """
    tb = exc.__traceback__
    for _ in range(skip_frames):
        if tb is None:
            break
        tb = tb.tb_next
    text = "".join(traceback.format_exception(type(exc), exc, tb))
    if len(text) > _MAX_TRACEBACK:
        half = _MAX_TRACEBACK // 2
        text = f"{text[:half]}\n  ... traceback truncated ...\n{text[-half:]}"
    return text.rstrip("\n")


def run_cell(cell: Cell, ns: dict) -> Output:
    """Run one cell against a namespace and describe what happened.

    NB: uses `exec` and `eval`.

    stdout/stderr are captured rather than leaked: on the JSON-lines
    protocol a stray print would corrupt the wire. A trailing expression
    was split off at compile time and becomes the display value.

    `BaseException`, not `Exception`: a cell calling `sys.exit()` or
    getting a `KeyboardInterrupt` must fail as a cell, not take the kernel
    down with it.
    """
    buffer = io.StringIO()
    started = perf_counter()

    try:
        body, tail = compile_cell(cell.src, cell.id)
    except SyntaxError as exc:
        # No frames to trim: nothing ran. The message carries the line and
        # the caret, which is the whole of what a SyntaxError has to say.
        return Output(
            cell=cell.id,
            status="error",
            seconds=perf_counter() - started,
            error=f"{type(exc).__name__}: {exc}",
            traceback=_format_traceback(exc, skip_frames=0),
        )

    try:
        with redirect_stdout(buffer), redirect_stderr(buffer):
            exec(body, ns)
            value = eval(tail, ns) if tail is not None else None
            images, notes = capture(value)
    except BaseException as exc:
        seconds = perf_counter() - started
        # A cell that plotted and *then* raised has left its figures open.
        # Capturing here both salvages them and closes them, so they cannot
        # reappear attributed to whichever cell runs next.
        with redirect_stdout(buffer), redirect_stderr(buffer):
            images, notes = capture(None)
        return Output(
            cell=cell.id,
            status="error",
            seconds=seconds,
            error=f"{type(exc).__name__}: {exc}",
            traceback=_format_traceback(exc),
            stdout=buffer.getvalue(),
            images=tuple(images),
            notes=tuple(notes),
        )

    return Output(
        cell=cell.id,
        status="ok",
        seconds=perf_counter() - started,
        value=brief(value),
        stdout=buffer.getvalue(),
        images=tuple(images),
        notes=tuple(notes),
    )
