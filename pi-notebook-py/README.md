# pi-notebook-py

A Jupyter-shaped Python notebook for the [pi coding agent](https://pi.dev): an ordered list of
cells over one persistent namespace, with a file on disk and plots the model can actually see.

```
> Load the CSV, plot the distribution, and save the notebook.

  nb_cell   import pandas as pd
  nb_cell   df = pd.read_csv("sales.csv")
  nb_cell   df.describe()
            * [3] c3 12.4ms  DataFrame(8, 4)
  nb_cell   df.total.hist()
            * [4] c4 240.1ms  Axes(1,)
              [attached: image/png]          <- the model sees the histogram
  nb_notebook save ./analysis.py
            saved 4 cell(s) to ./analysis.py
```

## Compared to pi-incremental-py

[pi-incremental-py](../pi-incremental-py/) derives a
dependency graph from each cell's module-level definitions and references, and recomputes the
minimum of the heap when a cell changes. That is genuinely more powerful, and it costs something:
one global may have only one providing cell, cross-cell mutation is invisible to it, and its
[authoring model](../pi-incremental-py/docs/authoring-model.md) is largely a list of what a cell
must not contain.

This package is the other end of that trade. There is no graph, no cache, and no rule about which
cell defines what — cells run top to bottom into a mutable dict, and ordinary Python works because
nothing is inferred from it. Pick this one when the notebook is exploratory, mutates state, or is
meant to end up as a file a human reads; pick the other when the same expensive computation is
going to be re-run many times as one input at a time changes.

The honest cost is that stale state is possible. Which is why the kernel's real job is reporting it.

## Staleness

Every response names the cells the last change left behind:

```
* [7] c2 1.2ms  15
stale (a cell above them changed since they ran): c3, c4 — nb_run {op: "all"} to bring the
notebook back in step
unrun: c5
failing: c6
```

The three are disjoint and mean different things:

| | |
|---|---|
| **unrun** | never executed since it was created, edited, or restarted |
| **stale** | has run, but a cell above it has changed, run, or moved since |
| **failing** | its last run raised |

The kernel never re-runs anything on its own — deciding is the agent's job. Two properties make the
report trustworthy, and both are pinned as tests: after `nb_run {op: "all"}` nothing is stale, and
editing cell *i* marks exactly the cells below it.

Editing a cell drops its previous output rather than keeping it on screen the way Jupyter does. The
output belonged to code the cell no longer contains, and showing it is exactly the confusion this
kernel exists to report.

## Tools

| Tool | What it does |
|---|---|
| `nb_cell` | Create or edit a cell and run it. `after` inserts anywhere; `run: false` writes without executing. |
| `nb_run` | `cell`, `all`, `above`, `below`. `all` restarts the namespace by default — Restart & Run All. |
| `nb_notebook` | `list`, `read`, `delete`, `move`, `restart`, `save`, `open`. |
| `nb_install` | pip, into the interpreter the kernel is actually running. |

And two slash commands, so the human shares the same namespace:

```
/nb                       list the cells
/nb add [name] <src>      add and run one
/nb run <id>  /nb run-all
/nb read <id>
/nb save <path>  /nb open <path>
/nb <expr>                evaluate without creating a cell
/nb-python <path>         pin the interpreter (restarts the kernel)
```

## The file format

`nb_notebook save` writes [jupytext](https://jupytext.readthedocs.io) percent format — cells as
`# %%` blocks in an ordinary `.py`:

```python
# %% setup id="c1"
import pandas as pd

# %% [markdown] id="c2"
# What this notebook is for

# %% id="c3"
df = pd.read_csv("sales.csv")
```

It opens in Jupyter and VS Code, diffs and greps like source, and pi's own `edit` tool can change
it. **It stores no outputs.** That is the deliberate cost of a file that diffs: an opened notebook
has code and no results, so every cell comes back `unrun`, and images are session-only.

`open` reconciles against what is already loaded. A cell whose id and source both still match keeps
its output and its execution count, so editing the file in a real editor and loading it back
re-runs only what actually changed. Anything new, edited, or moved comes back unrun — and keeps its
id, so the handle the agent is holding stays valid.

Saving over a file with no `# %%` in it is refused unless `overwrite` is passed. Any Python file
parses as a one-cell notebook, so parsing is too weak a guard against clobbering a real module.

## Plots

pi accepts image blocks in a tool result, so a figure goes to the model's eyes rather than being
described to it. After each cell the kernel saves and closes every open matplotlib figure, the way
the inline backend consumes them on display; failing that, it tries the display value's
`_repr_png_`, which is what PIL and most rendering libraries already speak.

matplotlib is never imported by the kernel — `py/nbkernel/display.py` only reads `sys.modules`, so
a notebook that never plots pays nothing, and the kernel stays stdlib-only. The subprocess is
spawned with `MPLBACKEND=Agg` so a headless import cannot reach for a display. Four images per cell
and about 1 MB each; over that, one downscale attempt and then a note saying what was dropped.

## Install

```bash
pi package add @ocramz/pi-notebook-py
```

Needs Python 3.12 or newer. The kernel finds an interpreter in this order: `PI_PYTHON`, then a pin
written by `/nb-python` into `.notebook/python-pin`, then a venv it builds and owns at
`.notebook/venv`. `.notebook/` gets a `.gitignore` covering both.

## Development

```bash
npm test                                       # TS units, against a real python subprocess
npm run typecheck
uv run python -m unittest discover -s test-py  # the kernel's own suite
uvx ruff check py test-py
```

The interactive and container tiers need the dev container — `make dev` then
`make test-tui PKG=pi-notebook-py` from the repo root. The interactive tier's live cases call a
model API and cost money; see the repo [README](../README.md).

`test-py/test_display.py` drives a *fake* pyplot on purpose: matplotlib is not a dependency and
must not become one just to test the kernel. Real matplotlib is covered one tier up, in
`test/container/test_plot_in_image.sh`, where it can be installed and driven over the actual wire.
