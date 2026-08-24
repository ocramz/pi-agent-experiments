# pi-incremental-py

An incremental computing kernel for Python, plus the [Pi coding agent](https://pi.dev)
extension that drives it. One package, two halves:

- **`py/`** — the kernel (stdlib-only Python 3.12+). Code is organised into
  cells whose dependency graph is derived statically (`symtable`); editing a
  cell re-runs it and its downstream, with content-addressed early cutoff,
  versioned namespaces for stateful cells, and tracked package installs. A
  JSON-lines protocol (`--serve`) exposes it to other processes.
- **`extensions/`, `src/`** — the pi extension: three agent tools
  (`py_cell`, `py_kernel`, `py_install`) and the `/py` command family,
  backed by a long-lived kernel subprocess.

## Kernel semantics

- **Identity.** Cells get kernel-generated 6-char base32 ids. An optional
  `name` is display metadata, never a lookup key. Execution order of
  independent cells is insertion order.
- **Create vs. modify.** `add_cell` always creates (returns the id);
  `set_cell` requires an existing id.
- **Versioned namespaces.** A self-reference (`x = x + 1`) is a temporal
  edge: the cell reads the last committed version of its own defs, so
  accumulators work and `rerun_cell` *advances* them (non-idempotent by
  design — `inspect` marks these cells `stateful: true`). A failing cell
  restores its last committed values instead of leaving the namespace
  half-written. The from-scratch-safe accumulator idiom:

  ```python
  try:
      count = count + 1
  except NameError:
      count = None
  ```

  (`None` is the neutral "nothing yet"; pick whatever initial value the
  cell should start from.) The try/except structure is what makes it
  converge between incremental runs and `run_all` replays.
- **Builtin shadowing.** If a cell defines `len`, dependents of `len` get
  a real DAG edge and re-run when it changes.
- **Failure isolation.** A cell that raises leaves its dependents
  `pending` (skipped, not poisoned); `failing` lists the broken ones.
  Cell stdout/stderr is captured into each result's `output` field and
  never touches the protocol stream.

## Kernel layout

- `py/reactive.py` — the core: `analyze` (symtable), `Notebook` (ids,
  staging with atomic rollback, versioned execution, topo-ordered run).
- `py/agent_kernel.py` — `CachingNotebook` (digest-keyed early cutoff),
  the `handle`/`serve` JSON-lines protocol.
- `py/env_kernel.py` — `EnvNotebook`: the installed-distribution set as a
  synthetic root of the DAG (all-or-nothing by design), kernel-aware
  `install`.

## Protocol

One JSON object per line on stdin, one response per line on stdout.
Every response is `{"ok": true, ...}` or `{"ok": false, "error": ...}`
(unexpected kernel bugs add `"internal": true`; the server never dies
mid-line).

```json
{"tool": "add_cell", "src": "rows = [1, 2, 3]", "name": "load", "run": true}
{"tool": "set_cell", "id": "k7x2qm", "src": "rows = [4, 5, 6]", "run": false}
{"tool": "delete_cell", "id": "k7x2qm"}
{"tool": "rerun_cell", "id": "k7x2qm"}
{"tool": "run_all", "restart": true}
{"tool": "apply_edits", "edits": [{"op": "add", "src": "a = 1"},
                                  {"op": "set", "id": "k7x2qm", "src": "..."},
                                  {"op": "delete", "id": "q3f9ma"}]}
{"tool": "plan_edits", "edits": [{"op": "set", "id": "k7x2qm", "src": "..."}]}
{"tool": "inspect"}
{"tool": "eval", "src": "len(rows)"}        # no cell created; human-facing
{"tool": "install", "packages": ["cowsay"], "upgrade": false}
```

## The extension

**Agent tools**

- **`py_cell`** — create (omit `id`) or modify (`id` given) a cell;
  `run: false` stages without executing.
- **`py_kernel`** — `inspect` / `rerun` / `run_all` / `delete` /
  `plan` / `apply` (atomic batches).
- **`py_install`** — pip-install into the kernel's environment; importing
  cells re-run automatically. Use instead of bash pip.

**Human commands** — `/py <expr>` evaluates in the live namespace without
creating a cell; `/py add [name] <src>`, `/py rerun <id>`, `/py run-all`,
`/py inspect`. Humans and the agent share one namespace.

**Environment.** By default the extension creates and owns a
project-scoped venv at `.incremental/venv` (`.incremental/` gets a
`.gitignore`), so `py_install` never touches the user's interpreters.
Pin a preexisting interpreter or venv with
`/py-python /path/to/venv-or-python` (stored in `.incremental/python-pin`,
takes effect on kernel restart). `PI_PYTHON` overrides everything, e.g.
for tests.

## Tooling

Python side is stdlib-only:

```bash
python3 -m unittest discover -s test-py    # kernel tests (46)
python3 py/agent_kernel.py --serve         # speak the protocol on stdin/stdout
```

With uv: `uv run python -m unittest discover -s test-py`,
`uvx ruff check py test-py`.

Extension side (this repo's standard tiers):

```bash
npm test            # node unit tests (kernel subprocess, formatting)
npm run typecheck   # tsc against pi's real declarations
npm run test:tui    # pi's real TUI in a pty, incl. live model cases
```
