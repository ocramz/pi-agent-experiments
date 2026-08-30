"""A Jupyter-shaped notebook kernel: an ordered list of cells, one namespace.

This is the sibling of pi-incremental-py's `kernel`, at the other end of
the same trade. That one derives a dependency graph from each cell's
module-level defs and refs, and recomputes the minimum of the heap when a
cell changes; the price is a set of rules about what a cell may contain —
one provider per global, no cross-cell mutation, no scratch variables.

This one has no graph. Cells run top to bottom into a mutable dict, and
ordinary Python works because nothing is inferred from it. The price is
that stale state is possible, so the kernel's job becomes *reporting* it:
every response names the cells an edit left behind, and never re-runs them
on its own initiative.

Layering, and each module imports only from the ones above it:

    errors      the exceptions the protocol layer expects
    env         which interpreter this is, and what is installed in it
    values      one-line summaries of runtime values
    source      text -> code, and text <-> percent-format file
    display     figures and `_repr_png_` -> image payloads
    cell        Cell, Output, and the one place `exec` is called
    notebook    the ordered list, the sequence counter, persistence

`protocol` sits above all of it and is the only module that knows about
JSON or about pip.
"""

from __future__ import annotations

from .cell import Cell, Output, fresh_namespace, run_cell
from .display import Image, capture
from .env import distributions, environment
from .errors import CellNotFound, NotebookError, PercentFormatError
from .notebook import Notebook
from .source import (
    KINDS,
    ParsedCell,
    compile_cell,
    emit_percent,
    parse_percent,
    read_frontmatter,
)
from .values import brief, globals_brief

__all__ = [
    "KINDS",
    "Cell",
    "CellNotFound",
    "Image",
    "Notebook",
    "NotebookError",
    "Output",
    "ParsedCell",
    "PercentFormatError",
    "brief",
    "capture",
    "compile_cell",
    "distributions",
    "emit_percent",
    "environment",
    "fresh_namespace",
    "globals_brief",
    "parse_percent",
    "read_frontmatter",
    "run_cell",
]
