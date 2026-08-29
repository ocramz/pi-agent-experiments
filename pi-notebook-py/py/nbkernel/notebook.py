"""An ordered list of cells over one shared namespace.

The Jupyter model : Cells run top to bottom into a mutable
dict, and editing one invalidates nothing on its own.

What the kernel adds is *hints*. Stale state is possible here:
the notebook tracks enough to say which cells an edit left behind,
and reports it on every response. It never acts
on that itself; deciding to re-run is the agent's job.

    unrun    never executed since it was created, edited, or restarted
    stale    has run, but a cell above it has moved since
    failing  its last run raised

The three are disjoint by construction: an edit clears `ran_at`, which
moves a cell out of `stale` and into `unrun` rather than leaving it in
both. `run_all` empties all three.
"""

from __future__ import annotations

import re
from pathlib import Path

from .cell import Cell, Output, fresh_namespace, run_cell
from .errors import CellNotFound, NotebookError
from .source import (
    KINDS,
    ParsedCell,
    emit_percent,
    forget_source,
    parse_percent,
)
from .values import globals_brief

__all__ = ["Notebook"]

_ID = re.compile(r"^c(\d+)$")

# One line of source is enough to recognise a cell you wrote; the `read`
# op exists for when it is not.
_PREVIEW = 72


class Notebook:
    def __init__(self) -> None:
        self.cells: list[Cell] = []
        self.ns: dict = fresh_namespace()
        self.path: str | None = None  # last saved or opened
        self._seq = 0
        self._next_id = 0
        self._exec_count = 0
        # Stands in for the `touched_at` of a cell above the first one, so
        # that a disturbance at index 0 has somewhere to be recorded. See
        # `_disturb`.
        self._floor = 0

    # ---- identity and lookup

    def _bump(self) -> int:
        """The next sequence number. Every operation that could invalidate
        something downstream takes one."""
        self._seq += 1
        return self._seq

    def _new_id(self) -> str:
        self._next_id += 1
        return f"c{self._next_id}"

    def _index(self, cid: str) -> int:
        for i, cell in enumerate(self.cells):
            if cell.id == cid:
                return i
        raise CellNotFound(cid)

    def cell(self, cid: str) -> Cell:
        return self.cells[self._index(cid)]

    def _disturb(self, index: int) -> None:
        """Record that the notebook changed shape from `index` down.

        Marking is done *above* the affected span, on the cell at
        `index - 1`, because `stale` reads a cell's own `touched_at` as
        affecting the cells below it and not itself. Marking at `index`
        would leave the cell that inherited the position looking fresh,
        when it is exactly as unreproducible as the ones under it. At
        index 0 there is no cell above, which is what `_floor` is for.
        """
        seq = self._bump()
        if index <= 0:
            self._floor = seq
        else:
            self.cells[index - 1].touched_at = seq

    def _position(self, after: str | None) -> int:
        """Where an insert lands. `after` is a cell id, or one of the two
        endpoints; omitted means the end, which is what an agent appending
        cells wants without having to name the last one."""
        if after is None or after == "end":
            return len(self.cells)
        if after == "start":
            return 0
        return self._index(after) + 1

    # ---- editing

    def add(
        self,
        src: str,
        after: str | None = None,
        kind: str = "code",
        name: str | None = None,
    ) -> Cell:
        if kind not in KINDS:
            raise NotebookError(f"kind must be one of {KINDS}, not {kind!r}")
        cell = Cell(
            id=self._new_id(), src=src, kind=kind, name=name, touched_at=self._bump()
        )
        self.cells.insert(self._position(after), cell)
        return cell

    def set(
        self,
        cid: str,
        src: str | None = None,
        name: str | None = None,
        kind: str | None = None,
    ) -> Cell:
        """Edit a cell in place.

        A change to the source (or the kind) resets the cell to unrun and
        drops its last output. Keeping that output would mean displaying
        the result of code that is no longer in the cell, which is exactly
        the confusion this kernel exists to report rather than create.
        A rename touches nothing: it cannot change what the cell computes.
        """
        cell = self.cell(cid)
        if kind is not None and kind not in KINDS:
            raise NotebookError(f"kind must be one of {KINDS}, not {kind!r}")
        changed = (src is not None and src != cell.src) or (
            kind is not None and kind != cell.kind
        )
        if src is not None:
            cell.src = src
        if kind is not None:
            cell.kind = kind
        if name is not None:
            cell.name = name or None
        if changed:
            cell.touched_at = self._bump()
            cell.ran_at = None
            cell.execution_count = None
            cell.last = None
        return cell

    def delete(self, cid: str) -> None:
        """Remove a cell. Its globals stay in the namespace.

        That is Jupyter's behaviour and not an oversight: retracting them
        would mean knowing which names this cell put there, which is the
        dependency analysis this kernel deliberately does not do. What the
        notebook reports instead is that everything from the hole down is
        stale — those cells' outputs are still in the namespace, but the
        notebook no longer reproduces them.
        """
        index = self._index(cid)
        del self.cells[index]
        forget_source(cid)
        self._disturb(index)

    def move(self, cid: str, after: str | None) -> Cell:
        """Reorder. The moved cell becomes unrun: its old result was
        produced in a position it no longer occupies."""
        old = self._index(cid)
        cell = self.cells.pop(old)
        try:
            new = self._position(after)
        except CellNotFound:
            self.cells.insert(old, cell)  # put it back before reporting
            raise
        self.cells.insert(new, cell)
        cell.ran_at = None
        cell.execution_count = None
        self._disturb(min(old, new))
        return cell

    def restart(self) -> None:
        """Throw the namespace away. Every cell becomes unrun."""
        self.ns = fresh_namespace()
        self._exec_count = 0
        for cell in self.cells:
            cell.ran_at = None
            cell.execution_count = None
            cell.last = None
        self._bump()

    # ---- execution

    def _run(self, cells: list[Cell]) -> list[Output]:
        """Run cells in the order given, stopping at the first failure.

        Stopping is what "Run All" does in Jupyter, and it is the right
        default here for the same reason: the cells below almost certainly
        depend on the one that just raised, and running them would bury the
        real error under a pile of NameErrors.
        """
        outputs: list[Output] = []
        for cell in cells:
            if cell.kind != "code" or not cell.src.strip():
                continue
            seq = self._bump()
            self._exec_count += 1
            output = run_cell(cell, self.ns)
            output.execution_count = self._exec_count
            cell.execution_count = self._exec_count
            cell.ran_at = seq
            cell.touched_at = seq
            cell.last = output
            outputs.append(output)
            if output.status == "error":
                break
        return outputs

    def run_cell(self, cid: str) -> list[Output]:
        return self._run([self.cell(cid)])

    def run_all(self, restart: bool = True) -> list[Output]:
        """Replay the notebook as a program.

        `restart` defaults to true — this is "Restart & Run All", and a run
        into a fresh namespace is the only one that proves the notebook
        reproduces. It is also what makes the staleness report meaningful:
        afterwards, nothing is stale, by construction.
        """
        if restart:
            self.restart()
        return self._run(list(self.cells))

    def run_above(self, cid: str) -> list[Output]:
        """Every cell before this one, exclusive."""
        return self._run(self.cells[: self._index(cid)])

    def run_below(self, cid: str) -> list[Output]:
        """This cell and every cell after it."""
        return self._run(self.cells[self._index(cid) :])

    def eval_src(self, src: str) -> Output:
        """Evaluate against the shared namespace without creating a cell.
        Advances no counters: this did not happen to the notebook."""
        return run_cell(Cell(id="<eval>", src=src), self.ns)

    # ---- introspection

    def stale(self) -> list[str]:
        """Cells that have run, but which a cell above them has outrun.

        One pass: carry the highest `touched_at` seen so far, and a cell is
        stale exactly when that high-water mark passed its own last run.
        """
        out: list[str] = []
        high = self._floor
        for cell in self.cells:
            if cell.ran_at is not None and high > cell.ran_at:
                out.append(cell.id)
            high = max(high, cell.touched_at)
        return out

    def unrun(self) -> list[str]:
        return [
            cell.id
            for cell in self.cells
            if cell.kind == "code" and cell.ran_at is None and cell.src.strip()
        ]

    def failing(self) -> list[str]:
        return [cell.id for cell in self.cells if cell.failing]

    def globals(self) -> dict[str, str]:
        return globals_brief(self.ns)

    def describe(self) -> dict:
        """The view the agent gets back, instead of a scrolling transcript."""
        stale = set(self.stale())
        return {
            "cells": [
                {
                    "id": cell.id,
                    "index": i,
                    "kind": cell.kind,
                    "name": cell.name,
                    "execution_count": cell.execution_count,
                    "lines": len(cell.src.splitlines()),
                    "preview": _preview(cell.src),
                    "state": (
                        "failing"
                        if cell.failing
                        else "stale"
                        if cell.id in stale
                        else "unrun"
                        if cell.ran_at is None
                        else "ok"
                    ),
                }
                for i, cell in enumerate(self.cells)
            ],
            "path": self.path,
        }

    def read(self, cid: str | None = None) -> list[dict]:
        """Full source, for one cell or all of them."""
        cells = self.cells if cid is None else [self.cell(cid)]
        return [
            {"id": c.id, "kind": c.kind, "name": c.name, "src": c.src} for c in cells
        ]

    # ---- persistence

    def _parsed(self) -> list[ParsedCell]:
        return [
            ParsedCell(src=c.src, kind=c.kind, name=c.name, id=c.id) for c in self.cells
        ]

    def save(
        self,
        path: str,
        overwrite: bool = False,
        remember: bool = True,
        notebook: str | None = None,
    ) -> dict:
        """Write the notebook as a percent-format `.py`.

        Refuses to clobber a file that is not already a notebook. Parsing
        is too weak a test — any Python file parses as a one-cell notebook
        — so the guard is the marker itself: no `# %%` in the file that is
        already there means it was written by something other than us.

        `remember=False` writes without adopting the path. That is what the
        automatic checkpoint uses: it is not the file the user asked for, so
        it must not become the answer to "where was this saved".
        """
        target = Path(path)
        if target.exists() and not overwrite:
            existing = target.read_text(encoding="utf8", errors="replace")
            if not any(
                line.lstrip().startswith("# %%") for line in existing.splitlines()
            ):
                raise NotebookError(
                    f"{path} exists and is not a percent-format notebook "
                    "(no `# %%` marker) — pass overwrite to replace it"
                )
        text = emit_percent(self._parsed(), notebook=notebook)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf8")
        if remember:
            self.path = path
        return {"path": path, "cells": len(self.cells), "bytes": len(text)}

    def load(self, path: str) -> dict:
        """Read a percent-format `.py` in, reconciling against what is here.

        A cell whose id and source both still match keeps its output and
        its execution count, so editing the file in a real editor and
        loading it back re-runs only what actually changed. Everything else
        — new, edited, or merely moved — comes back unrun.
        """
        target = Path(path)
        if not target.exists():
            raise NotebookError(f"no such file: {path}")
        parsed = parse_percent(target.read_text(encoding="utf8"))

        previous = {cell.id: (i, cell) for i, cell in enumerate(self.cells)}
        cells: list[Cell] = []
        taken: set[str] = set()
        for index, item in enumerate(parsed):
            found = previous.get(item.id) if item.id else None
            if found is not None and found[1].id not in taken:
                # Same cell, possibly edited on disk. Keeping the id matters:
                # it is the handle the agent already has, and a hand-edit in
                # an editor should not silently invalidate it.
                old_index, kept = found
                intact = (
                    kept.src == item.src
                    and kept.kind == item.kind
                    and old_index == index
                )
                kept.src, kept.kind, kept.name = item.src, item.kind, item.name
                if not intact:
                    kept.ran_at = None
                    kept.execution_count = None
                    kept.last = None
                    kept.touched_at = self._bump()
                cells.append(kept)
                taken.add(kept.id)
                continue
            adopt = item.id and item.id not in previous and item.id not in taken
            cell = Cell(
                id=item.id if adopt else self._new_id(),
                src=item.src,
                kind=item.kind,
                name=item.name,
                touched_at=self._bump(),
            )
            cells.append(cell)
            taken.add(cell.id)

        for cell in self.cells:
            if cell.id not in taken:
                forget_source(cell.id)
        self.cells = cells
        self.path = path
        # Ids adopted from the file must not be handed out a second time.
        self._next_id = max(
            [self._next_id]
            + [int(m.group(1)) for c in cells if (m := _ID.match(c.id)) is not None]
        )
        return {"path": path, "cells": len(cells)}


def _preview(src: str) -> str:
    line = next((s for s in src.splitlines() if s.strip()), "")
    return line if len(line) <= _PREVIEW else line[:_PREVIEW] + "..."
