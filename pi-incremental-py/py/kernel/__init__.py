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

Where things live, bottom up (each module imports only from the ones
above it in this list):

    errors.py     the three ways a set of cells fails to be a notebook
    values.py     digest (identity) and brief (description) of a value
    analysis.py   defs/refs/imports recovered from source, via symtable
    cell.py       Cell (analysed + compiled), Result, Outcome, run_cell
    edits.py      Edit: the vocabulary of a change
    graph.py      Graph: providers, parents, kids, topological order
    notebook.py   Notebook: identity, staging, execution, introspection

The tool surface — the JSON-lines protocol and `install` — is one level
out, in `py/protocol.py`, because pip is a tool acting on a kernel rather
than part of one.
"""

from __future__ import annotations

from .analysis import Analysis, Survey, analyze
from .cell import Cell, Memo, Outcome, Result, run_cell
from .edits import Edit
from .errors import (
    CycleError,
    DuplicateNameError,
    MultipleDefinitionError,
    StatefulVariantError,
)
from .graph import Graph
from .notebook import Notebook
from .variants import Variant
from .values import address, brief, digest, env_digest

__all__ = [
    "Analysis",
    "Cell",
    "CycleError",
    "DuplicateNameError",
    "Edit",
    "Graph",
    "Memo",
    "MultipleDefinitionError",
    "Notebook",
    "Outcome",
    "Result",
    "StatefulVariantError",
    "Survey",
    "Variant",
    "address",
    "analyze",
    "brief",
    "digest",
    "env_digest",
    "run_cell",
]
