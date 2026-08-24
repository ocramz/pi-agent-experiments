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

## Install

```bash
pi install npm:@ocramz/pi-incremental-py
```

Needs **Node 24 or later** — the package ships TypeScript and relies on
Node's native type stripping, so there is no build step and nothing to
compile.

It also needs a **CPython 3.12 or later** it can find, which the other
extensions in this repo do not. That floor is not a preference: `py/kernel.py`
reads comprehension scopes the way PEP 709 made them in 3.12, so on an older
interpreter the dependency analysis is *wrong* rather than absent. The
extension resolves one at first use, in this order — `PI_PYTHON`, an
interpreter or venv pinned in `.incremental/python-pin` (set it with
`/py-python`), or a venv it builds and owns at `.incremental/venv`,
bootstrapped from a 3.12+ it finds on `PATH`. Nothing is installed into
the user's own interpreters, and `.incremental/` is self-gitignoring.

For local development, point pi at a checkout instead:

```bash
pi install /path/to/pi-incremental-py      # user settings, ~/.pi/agent/settings.json
pi install -l /path/to/pi-incremental-py   # project settings, .pi/settings.json
pi -e /path/to/pi-incremental-py           # this run only, nothing written
```

Project-scoped packages (`-l`) load only once the project is trusted; a
user-scoped install has no such gate.

The published tarball carries `py/kernel.py` and `py/protocol.py` — the
kernel is resolved relative to the installed `src/`, so the Python half
travels with the npm package and needs no separate install. `pyproject.toml`
and `uv.lock` are for working *on* the kernel (ruff, hypothesis) and are
deliberately not shipped.

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

Two modules, one `Notebook` class.

- `py/kernel.py` — everything that determines a key or an edge: `analyze`
  (symtable), `digest`/`env_digest`, and `Notebook` (ids, staging with
  atomic rollback, versioned execution, topo-ordered run, digest-keyed
  early cutoff, the installed-distribution set as a synthetic root of the
  DAG).
- `py/protocol.py` — the tool surface: the `handle`/`serve` JSON-lines
  protocol, and `install` as a function over a notebook (pip acts on a
  kernel; it is not part of one).

A cell's cache key is a hash of its source plus the digests of every
global it reads. Cells containing an `import` also mix in the digest of
the installed distribution set, so `pip install` invalidates exactly the
importing cells and their descendants — coarse, all-or-nothing, never
wrong. Keys are pure content addresses: they must not vary between
processes, which is why function digests walk nested code objects instead
of `repr`-ing them.

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

The kernel is stdlib-only — `python3 -S -c "import kernel, protocol"` is
part of the container tier, so the claim is checked rather than asserted.
Its *tests* are not: hypothesis is a dev dependency, and the suite needs
it.

```bash
uv sync --group dev                        # ruff + hypothesis
uv run python -m unittest discover -s test-py   # kernel tests (72)
uvx ruff check py test-py
python3 py/protocol.py                     # speak the protocol on stdin/stdout
```

`test-py/test_properties.py` adds property-based tests for the laws the
unit suite only spot-checks: incremental edits reach the same namespace as
a from-scratch replay, early cutoff is invisible, a rejected batch changes
nothing, `plan` bounds `apply`, failures isolate, and keys are content
addresses. It imports hypothesis unconditionally — these are the cases
that check the laws, so a missing dependency fails the run instead of
silently removing 21 tests from it.

Extension side (this repo's standard tiers):

```bash
npm test              # node unit tests (kernel subprocess, formatting)
npm run typecheck     # tsc against pi's real declarations
npm run test:tui      # pi's real TUI in a pty, incl. live model cases
npm run test:container # the tiers below, in the image userland
```

The container tier is offline — no model, no API key — because the live TUI
cases already cover a model reaching `py_cell` and `py_install`. What it
covers instead is the *environment*: a pristine filesystem with no
`.incremental/`, an unprivileged uid, `HOME` on `/tmp`, and an interpreter
with nothing in its site-packages.

| suite | reaches |
|---|---|
| `test_kernel_in_image.sh` | `test-py/` on a bare interpreter — the only automated run it gets, and the only place "stdlib-only" is falsifiable |
| `test_protocol_in_image.sh` | the JSON-lines protocol spoken over a pipe with no node in sight: early cutoff (with a control), failure isolation, surviving a bad request mid-stream, and the cache key being identical in two fresh processes |
| `test_no_python.sh` | the pinned image, which has *no* Python: the kernel must answer with an actionable error instead of taking the pi session down |
| `test_unit_in_image.sh` | the node unit suite where `resolvePython` has to build its venv from scratch as uid 65532 |
| `test_install_in_image.sh` | a real PyPI install into a freshly built project venv, and the invalidation it implies — the importing cell re-runs, the plain one does not |

It runs against a second image (the repo's pinned userland plus a 3.12+
CPython), built from `test/container/Containerfile` and published by
`.github/workflows/publish-py-image.yml`. Until `DEFAULT_PY_TEST_IMAGE` is
pinned in [shared/versions.env](../shared/versions.env), `run.sh` builds it
locally and says so.
