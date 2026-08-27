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

The environment is not the only input the namespace cannot see. A cell
reading the clock, a file, an environment variable or a URL has an input
that appears nowhere in `refs`, and everything above is a lie about such
a cell: its key is constant over a varying input, so it reports `cached`
over a stale value. Python offers no way to infer this — a name
blacklist is defeated by `f = time.time`, by `getattr`, and by any C
extension that opens a socket without naming one — so the world is
*observed* rather than predicted, by an audit hook in `cell.py`, and
what is observed is split by whether it can be digested:

- a **file read** becomes another input to the key. A file has content,
  so the cell caches until that content actually changes, and a
  regenerated-but-identical file propagates nothing at all.
- a **socket or a subprocess** makes the cell *volatile*: there is no
  digest for "the internet", so the only sound answer is to run it every
  time.

The hook cannot see everything — `time.time()` raises no audit event —
so a cell may also *declare* itself volatile, which is the one thing
about a cell that is stated rather than derived. Volatility is inherited
by everything downstream, because `digest` sees a function's code,
closures, defaults and globals, and every one of those sits still for
`def now(): return time.time()`. Marking its defining cell alone would
leave every caller happily caching.

A volatile cell means exactly one thing: never served from cache. It is
not a claim about side effects, and `run_all` replays it like any other
— running a Python program twice sends the request twice, which is the
unsurprising reading and the only one the kernel can honour without a
store of past values.

The kernel also supports `eval_src`: evaluate a snippet in the live
namespace without creating a cell (no defs recorded, no graph impact) —
used by human-facing `/py` interactions.

Where things live, bottom up (each module imports only from the ones
above it in this list):

    errors.py     the three ways a set of cells fails to be a notebook
    values.py     digest (identity), file_digest (a file's), brief (shape)
    analysis.py   defs/refs/imports recovered from source, via symtable
    cell.py       Cell (analysed + compiled), Result, Outcome, run_cell,
                  and the audit hook that watches one run
    edits.py      Edit: the vocabulary of a change
    graph.py      Graph: providers, parents, kids, topological order,
                  and the taint that carries volatility downstream
    notebook.py   Notebook: identity, staging, execution, introspection

The tool surface — the JSON-lines protocol and `install` — is one level
out, in `py/protocol.py`, because pip is a tool acting on a kernel rather
than part of one.
"""

from __future__ import annotations

from .analysis import Analysis, Survey, analyze
from .cell import Cell, Outcome, Result, run_cell
from .edits import Edit, as_flag
from .errors import CycleError, DuplicateNameError, MultipleDefinitionError
from .graph import Graph
from .notebook import Notebook
from .values import brief, digest, env_digest, file_digest

__all__ = [
    "Analysis",
    "Cell",
    "CycleError",
    "DuplicateNameError",
    "Edit",
    "Graph",
    "MultipleDefinitionError",
    "Notebook",
    "Outcome",
    "Result",
    "Survey",
    "analyze",
    "as_flag",
    "brief",
    "digest",
    "env_digest",
    "file_digest",
    "run_cell",
]
