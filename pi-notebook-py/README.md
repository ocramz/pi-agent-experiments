# pi-notebook-py

A Jupyter-shaped Python notebook for the [pi coding agent](https://pi.dev).

A notebook is an ordered list of cells over a persistent namespace. Notebooks can be saved to disk as regular Python files.
The extension keeps separate venvs (a default one, and optionally one per notebook).
Cells may return image data, which may be fed to vision-capable models.

```
> Load the CSV, plot the distribution, and save the notebook.

  nb_cell   import pandas as pd
  nb_cell   df = pd.read_csv("sales.csv")
  nb_cell   df.describe()
            * [3] c3 12.4ms  DataFrame(8, 4)
  nb_cell   df.total.hist()
            * [4] c4 240.1ms  <Axes: >
              [attached: image/png]          <- the model sees the histogram
  nb_notebook save ./analysis.py
            saved 4 cell(s) to ./analysis.py
```

## Staleness annotations

Every response shows which cells may have stale results:

```
* [7] c2 1.2ms  15
failing: c6
stale (a cell above them changed since they ran): c3, c4 — nb_run {op: "all"} to bring the
notebook back in step
unrun: c5
```

| | |
|---|---|
| **failing** | its last run raised |
| **stale** | has run, but a cell above it has changed, run, or moved since |
| **unrun** | never executed since it was created, edited, or restarted |

The kernel never re-runs anything on its own — deciding is the agent's job. Two properties make the
report trustworthy, and both are pinned as tests: after `nb_run {op: "all"}` nothing is stale, and
editing cell *i* marks exactly the cells below it.

Editing a cell drops its previous output rather than keeping it on screen the way Jupyter does. The
output belonged to code the cell no longer contains, and showing it is exactly the confusion this
kernel exists to report.

## Tools

| Tool | What it does |
|---|---|
| `nb_cell` | The cell list: `add`, `edit`, `delete`, `move`, `list`, `read`. `after` puts a cell anywhere; `run: false` writes without executing; `kind: "markdown"` makes a prose cell, which is never executed. |
| `nb_run` | `cell`, `all`, `above`, `below`. `all` always restarts the interpreter first (Restart & Run All) — for a replay over the *current* namespace, `below` from the first cell is the same run without the restart. `eval` evaluates one expression without creating a cell; `file` runs a `.py` as a fresh process. Neither touches a cell. |
| `nb_notebook` | The notebook as a named document: `notebooks`, `use` (`create: true` starts a fresh one), `save`, `open` (`run: true` to run every cell after loading), and the `digest` report. |
| `nb_env` | The interpreter the cells run in: `install` (pip, into the interpreter the kernel is actually running), `report` (which python, and what is in it), `restart` (replace it — the namespace and every imported module go, the cells stay). |

And two slash commands, so the human shares the same namespace:

```
/nb                       list the cells
/nb add <src>             add and run one
/nb run <id>  /nb run-all
/nb read <id>
/nb save <path>  /nb open <path>
/nb notebooks             every notebook in this project, and its environment
/nb new <name>  /nb use <name>
/nb drop-venv <name>      delete one notebook's venv
/nb <expr>                evaluate an expression without creating a cell
/nb-python <path>         pin this notebook's interpreter (restarts the kernel)
/nb-python clear          undo the pin; back to the notebook's own venv
```

## Four reports

None of these disturbs a cell: nothing becomes stale, nothing is re-run, and no cell moves.

```
nb_env {op: "report"}       which python is this, and what is in it
nb_notebook {op: "digest"}  is the committed checkpoint still what the kernel holds
nb_run {op: "file", path}   run a .py in this interpreter, as a fresh process
nb_run {op: "eval", src}    evaluate one expression, without creating a cell
```

**`nb_env {op: "report"}`** prints the interpreter that is *actually running*, which of the four rules below chose it,
the version, and every installed package as `name==version` lines — a requirements.txt you can store
next to a result as `env.lock`. The package list comes from `importlib.metadata`, in the kernel
process, so it needs no pip: a uv-built venv has none, and bootstrapping one to answer would mutate
the environment the question was about. When `uv` is on `PATH`, `uv pip freeze` answers instead,
because it renders an editable or VCS install as the reference it is rather than as a bare version.
The report names which of the two produced it, and `lock: false` asks for just the interpreter.

The interpreter is read from the live process rather than re-derived, because the two can disagree:
if a venv cannot be built, the kernel comes up under the base interpreter and the rule that chose the
path is describing an environment nothing is running in. That case is called out in the report,
since it also means `nb_env {op: "install"}` has been installing somewhere else.

**`digest`** hashes the checkpoint and asks the kernel to hash the file it *would* write. They should
always match — the checkpoint is rewritten after every change — so a divergence means one of exactly
two things: the file was edited outside the session, or a checkpoint write failed. The report says
which hashes differ and names the call that resolves it. It never starts a kernel to answer: with no
process running there is nothing that could have diverged, and building a venv to compute a hash
would be a strange thing to do to someone who asked for a hash.

**`nb_run {op: "file"}`** runs a `.py` under the notebook's own interpreter, as an ordinary fresh
process — so it sees whatever `nb_env {op: "install"}` put there, and binds nothing in the namespace. It is how
to check the helper module from the section below before importing it, without paying a restart or
making everything stale. It takes `args` as `sys.argv[1:]`, has its own time budget separate from the
kernel's (a script that hangs costs the script, not the session), and keeps the tail of each output
stream. Two things it deliberately does not do: capture plots — a fresh process has no figure
hook — and put the project directory on `sys.path`. A script gets its *own* directory there, exactly
as `python file.py` from a shell would, where a cell gets the project directory; see
[docs/semantics.md](docs/semantics.md) §3.10.

**`nb_run {op: "eval"}`** evaluates one expression against the live namespace and creates no cell —
the agent's half of what `/nb <expr>` has always been for the human. It is for looking: a shape, a
column name, a length. It is the one report that is not purely a read, because an expression can
have side effects, so it counts as a mutation for the purposes of the session's own bookkeeping even
though it moves no cell. Nothing about it is recorded in the notebook, which is the point and also
the limit: anything worth keeping should be a cell.

## Notebooks have their own environments

A session is always *on* a named notebook — `default` until you say otherwise. The name does two
things:

```
<project>/.pi/notebooks/sales.py     the checkpoint. Source. Commit it.
~/.pi/notebook-py/venvs/<project>/sales/    its interpreter. Never in the repo.
```

`nb_env {op: "install"}` installs into the notebook the session is on, and nowhere else, so two notebooks in
one project can hold conflicting versions of the same package. Switching is `nb_notebook {op:
"use", name}` — it discards the namespace, because the new notebook has a different interpreter and
carrying globals across would be exactly the stale state this kernel exists to report.

The checkpoint is rewritten after every change, so it is always current and always committable. It
carries the notebook's name in a jupytext frontmatter fence:

```python
# ---
# notebook: sales
# ---

# %% id="c1"
import pandas as pd
```

which is what lets `open` put a file back into the environment it was written under instead of
guessing. A file *without* a fence — anything jupytext wrote, or any plain `.py` — opens in the
current notebook, and the reply says so rather than letting you find out at the first `ImportError`.

### What to commit

`.pi/notebooks/*.py` and nothing else. There is no ignore rule to add, because there is nothing to
ignore: venvs are not in the working tree at all. That is deliberate rather than tidy — a venv
carries an absolute `home =` in its `pyvenv.cfg`, absolute shebangs in its scripts, and
platform-specific compiled extensions, so a committed one is *broken* on every other machine, not
merely large. `git add -A` cannot sweep one in because there is none to sweep.

To reclaim the disk: `/nb drop-venv <name>` deletes one notebook's venv and never its source.
`/nb notebooks` prints where each one is, including a venv left stranded by a `/nb-python` pin.
It is a slash command rather than an agent tool because deciding a notebook is finished is yours
to do, not the model's — see §3.8 of [docs/semantics.md](docs/semantics.md).

## The file format

`nb_notebook save` writes [jupytext](https://jupytext.readthedocs.io) percent format — cells as
`# %%` blocks in an ordinary `.py`:

```python
# %% id="c1"
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
spawned with `MPLBACKEND=Agg`, unless the environment already sets one, so a headless import cannot
reach for a display. Four images per cell and about 1 MB each; over that, one downscale attempt and
then a note saying what was dropped.

## The project directory is importable

The kernel runs in the project directory and puts it on `sys.path`, as Jupyter does, so long or
reusable code can go in a `.py` file next to the notebook and be imported from a small cell. Editing
that file afterwards needs `nb_env {op: "restart"}`: `import` is a `sys.modules` hit, so a
restart here replaces the interpreter rather than just resetting the namespace — the cells survive,
by way of the checkpoint. Same caveat as Jupyter for the path order: a project file named `io.py`
shadows the stdlib one. See [docs/semantics.md](docs/semantics.md) §3.9.

## Install

```bash
pi package add @ocramz/pi-notebook-py
```

Needs Python 3.12 or newer. Each notebook gets its own interpreter, found in this order:

| | |
|---|---|
| `PI_PYTHON` | escape hatch; overrides everything, including per notebook |
| `~/.pi/notebook-py/pins/<project>/<name>` | written by `/nb-python`. Machine-local, because an absolute path is |
| `notebookPy.python.<name>` in `.pi/settings.json` | the pin a team can share. Relative, so `"./.venv"` means the same thing everywhere |
| `~/.pi/notebook-py/venvs/<project>/<name>` | otherwise: a venv this extension builds and owns |

`<project>` is the directory's basename plus a hash of its real path, so two checkouts of the same
repo do not share an environment. `uv` is used to build the venv when it is on `PATH` — its cache
hardlinks, which is what makes a venv per notebook cheap — and `python -m venv` otherwise.

Everything else is optional, under `notebookPy` in `.pi/settings.json`:

```json
{
  "notebookPy": {
    "default": "sales",
    "python": { "sales": "./.venv" },
    "venvRoot": "/fast-disk/nb-venvs"
  }
}
```

`default` names the notebook a session opens on — the one called `default`, when the key is absent.
`PI_NOTEBOOK` overrides it, which is how a container or a CI job picks one without editing the
project's settings.
`PI_NOTEBOOK_VENV_ROOT` overrides `venvRoot`, and `PI_NOTEBOOK_HOME` moves the venvs and the pins
together. If a `venvRoot` ends up inside the repository, the pattern is appended to
`.git/info/exclude` — repo-local, untracked, in nobody's diff — so the guarantee above survives the
escape hatch.

## Running in a container

The venvs live under `$HOME`, so give `$HOME/.pi/notebook-py` a named volume. Without one, every
fresh container rebuilds every notebook's environment from scratch:

```bash
podman run -it --rm \
  -v "$PWD":/workspace -w /workspace \
  -v pi-config:/root/.pi \
  -v pi-notebook-venvs:/root/.pi/notebook-py \
  <your-pi-image>
```

(`docker run` is the same. This repo's own [Makefile](../Makefile) mounts exactly these for `make
dev`, if you want a worked example.) The nesting is deliberate: pi's credentials and sessions are
kilobytes with a long life, and the venvs are gigabytes you may want to throw away without logging
in again.

**The container builds its own venvs, separate from the host's** — and it has to. If they were in
the working tree they would be shared over the bind mount, and a venv works for exactly one side:
the interpreter path, the shebangs and every compiled extension differ between a macOS host and a
Linux image. Keying off `$HOME` means each side builds its own with no coordination and no
configuration.

**Cleanup.** Removing or replacing the container neither reclaims the venvs nor loses them — that
is the whole point of the volume. To actually reclaim:

```bash
podman volume rm pi-notebook-venvs      # all of them
```

or, from inside a session, `/nb drop-venv <name>` for one notebook at a time. The checkpoints
under `.pi/notebooks/` are in the repo and are never touched by either.

## Breaking changes in 0.3

The tool grammar was re-cut so that each tool owns one thing — the cell list, execution, the
document, the interpreter — and each action has one spelling. Nothing moved on the wire; every op
still reaches the verb it always did.

| 0.2 | 0.3 |
|---|---|
| `nb_cell {src, …}` (no `id`) | `nb_cell {op: "add", src, …}` |
| `nb_cell {id, src, …}` | `nb_cell {op: "edit", id, src, …}` |
| `nb_notebook {op: "delete" \| "move" \| "list" \| "read"}` | `nb_cell {op: <same>}` |
| `nb_notebook {op: "new", name}` | `nb_notebook {op: "use", name, create: true}` |
| `nb_notebook {op: "env", lock?}` | `nb_env {op: "report", lock?}` |
| `nb_notebook {op: "restart"}` | `nb_env {op: "restart"}` |
| `nb_install {packages, upgrade?}` | `nb_env {op: "install", packages, upgrade?}` |
| `nb_run {op: "all", restart: false}` | `nb_run {op: "below", id: <first cell>}` |
| — | `nb_run {op: "eval", src}`, new: the agent's half of `/nb <expr>` |

Two removals worth their own line. `nb_run`'s `restart` parameter is gone: `op: "all"` always
restarts, because it is the only run that proves the notebook reproduces, and the no-restart replay
is `run_below` from the first cell — the same call, under a name that does not promise a guarantee
it cannot give. And `nb_notebook {op: "new"}` is gone into `use`'s `create` flag, which asserts in
both directions: `create: true` fails if the notebook exists, its absence fails if it does not, so a
mistyped name cannot quietly become a new empty notebook.

The `/nb` slash commands are unchanged. They are a human's surface, and their last clause is a
bare-expression `eval` fallback — every keyword added to that matcher is an expression a person can
no longer evaluate, so the keyword set stays small.

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
