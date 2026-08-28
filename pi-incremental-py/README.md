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
extensions in this repo do not. That floor is not a preference:
`py/kernel/analysis.py` reads comprehension scopes the way PEP 709 made them
in 3.12, so on an older
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

The published tarball carries `py/kernel/` and `py/protocol.py` — the
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

  `refs` means *globals read from the incoming namespace* — what a cell's
  result depends on, and so what belongs in its cache key. `symtable`
  reports which names are assigned and which are referenced but never in
  what order, so two corrections make it mean that:

  - A **trailing display expression** reads back what the body just
    wrote. `x = 1` followed by a bare `x` is the display idiom, not an
    accumulator, even though symtable sees x assigned *and* referenced
    exactly as in `x = x + 1`. Discounted only when the body's own top
    level is certain to have bound the name — `if flag: x = 1` followed
    by `x` keeps its self-reference, because when the branch is not taken
    the tail really does read the previous committed value.
  - An **augmented assignment** is a read. `x += 1` binds through a
    Store with no Load node anywhere, so symtable calls it assigned and
    not referenced. Without this, `n += 1` and `n = n + 1` would behave
    differently: only the second would be `stateful` and rekey.

  Everything the analysis is unsure about keeps the reference, so it can
  only ever drop a dependency it has proved spurious.
- **Builtin shadowing.** If a cell defines `len`, dependents of `len` get
  a real DAG edge and re-run when it changes.
- **The world is observed, not inferred.** A cell reading the clock, a
  file or a URL has an input that appears nowhere in `refs`, so its key
  is constant over a varying input and it reports `cached` over a stale
  value. Python cannot be statically analysed for this — `f = time.time`,
  `getattr`, and any C extension that opens a socket all defeat a name
  blacklist — so an audit hook watches each run and sorts what it sees by
  whether it can be digested:

  - **Files read** become cache-key inputs. The cell caches until the
    file's *contents* change, so a regenerated-but-identical file
    propagates nothing. Digests are stat-gated: an unchanged size and
    mtime reuse the memo without a re-read, so the steady-state cost is
    one `stat`. The hole this leaves is an overwrite that *preserves*
    mtime (`cp -p`, `rsync -t`, `tar -x`), which is missed; closing it
    would mean re-reading every file on every key computation. Files
    under the interpreter's own prefixes are ignored — `import json`
    really does open a dozen of them, and `env` already covers those.
    A non-regular file (FIFO, `/dev/*`) or one over 8 MiB is refused
    rather than hashed, and the cell goes volatile instead.
  - **Sockets and subprocesses** make the cell **volatile**: there is no
    digest for "the internet", so it must run every time.

- **`volatile`.** What the hook cannot see — `time.time()` raises no
  audit event — is declared, as a parameter on `py_cell` and on an edit.
  It means one thing: *never served from cache*. Everything downstream
  inherits it, because `digest` sees a function's code, closures,
  defaults and globals, all of which sit still for
  `def now(): return time.time()` — so marking only its defining cell
  would leave every caller caching a stale answer. It is **not** a claim
  about side effects: `run_all` replays a volatile cell like any other,
  because running a Python program twice sends the request twice, and the
  kernel has no store of past values with which to do otherwise.
- **Failure isolation.** A cell that raises leaves its dependents
  `pending` (skipped, not poisoned); `failing` lists the broken ones.
  Cell stdout/stderr is captured into each result's `output` field and
  never touches the protocol stream.

## Kernel layout

The `py/kernel/` package is everything that determines a key or an edge.
Each module imports only from the ones above it, so the list is also the
dependency order:

| module | holds |
|---|---|
| `errors.py` | the three ways a set of cells fails to be a notebook |
| `values.py` | `digest` (is this value still the same?), `file_digest` (the same, for a file a cell read) and `brief` (what is it?) |
| `analysis.py` | `analyze`: defs/refs/imports recovered from source via `symtable`, plus the AST corrections symtable needs |
| `cell.py` | `Cell` (analysed and compiled), `Result`, `Outcome`, `run_cell`, and the audit hook that watches one run |
| `edits.py` | `Edit`: the vocabulary of a change |
| `graph.py` | `Graph`: providers, parents, kids, topological order, and the `taint` that carries volatility downstream — built whole, validated at construction |
| `notebook.py` | `Notebook`: ids, staging with atomic rollback, versioned execution, topo-ordered run, digest-keyed early cutoff |

`py/kernel/__init__.py` re-exports the public surface (`Notebook`, `Edit`,
`Result`, `analyze`, `digest`, `env_digest`, the errors), so `from kernel
import …` is the only import anything outside the package needs.

- `py/protocol.py` — the tool surface, one level out: the `handle`/`serve`
  JSON-lines protocol, and `install` as a function over a notebook (pip
  acts on a kernel; it is not part of one).

A cell's cache key is a hash of its source, the digests of every global
it reads, and the digests of every file it read last run. Cells
containing an `import` also mix in the digest of the installed
distribution set, so `pip install` invalidates exactly the importing
cells and their descendants — coarse, all-or-nothing, never wrong. Keys
are pure content addresses: they must not vary between processes, which
is why function digests walk nested code objects instead of `repr`-ing
them, and why a file contributes its contents rather than its timestamp.

The key has two halves, taken at different moments. The globals half must
be computed *before* the cell runs, because a self-reference reads the
previous committed version. The files half is completed *after*, because
a cell's file inputs are only discovered by running it — keying the
result on the set known beforehand would make every file-reading cell pay
for itself twice: once to learn what it reads, once more because the key
then moved underneath it.

## Protocol

One JSON object per line on stdin, one response per line on stdout.
Every response is `{"ok": true, ...}` or `{"ok": false, "error": ...}`
(unexpected kernel bugs add `"internal": true`; the server never dies
mid-line).

```json
{"tool": "add_cell", "src": "rows = [1, 2, 3]", "name": "load", "run": true}
{"tool": "add_cell", "src": "t = time.time()", "volatile": true}
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

**Context.** A pi transcript only grows, but the kernel recomputes, so a
cell re-run ten times would otherwise leave ten values in the model's
context, nine of them wrong. The extension registers a `context` hook that
re-renders its own past tool results before each LLM call: the newest run
of a cell keeps its value, earlier ones collapse to `- superseded: c3`,
and whole-kernel snapshots (the `globals`/`pending`/`failing` tails, an
`inspect` dump) survive only on the newest message carrying one. Two things
are deliberately exempt — a **stateful** cell's successive values are the
record of an accumulator advancing rather than stale copies of one truth,
and an **error** is a fact about an attempt that, unlike a value, cannot be
recovered by asking the kernel again. Both keep their line and lose only
their captured stdout. A kernel restart voids everything before it, and a
mutation made through a `/py` command — which leaves nothing in the
transcript — appends a note telling the agent to re-inspect.

The hook works on a copy that pi hands it for that one request: the session
file, the transcript and what you see in the TUI are unaffected. The cost
is prompt-cache locality, since rewriting a message invalidates the
provider's cached prefix from that point on. The re-render is a pure
function of what the kernel returned, so that happens once per *new*
supersession rather than on every call. Turn it off with:

```jsonc
// .pi/settings.json
{ "incrementalPy": { "contextFilter": false } }
```

or `PI_PY_CONTEXT_FILTER=0` in the environment, which wins over the file.
Off is the old behaviour exactly — the hook returns pi's no-op and the
messages are never touched. Project-local settings are honoured only for a
trusted project.

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
uv run python -m unittest discover -s test-py   # kernel tests (86)
uvx ruff check py test-py                  # also a CI job; pinned in shared/versions.env
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
npm run dev:log       # a scratch pi session with the prompt logger attached
```

### What the model is told

Three tools carry long descriptions, nine `promptGuidelines` and a documented
parameter each. None of it appears in a message, so no assertion about a
transcript can reach it — and a `promptSnippet` that goes missing costs the tool
its line in the system prompt's *Available tools* section while every other tier
stays green.

`test/tui/prompt.test.ts` closes that. The faux provider is handed pi's whole
`Context`, so `test/tui/faux-model.ts` records `systemPrompt` and `tools`
alongside the messages, and the cases assert on the prompt as assembled, the
schemas as sent, and a snapshot of this extension's own contribution:

```bash
node --test test/tui/prompt.test.ts                      # free: no key, no network
PI_UPDATE_PROMPT=1 node --test test/tui/prompt.test.ts   # re-record the snapshot
```

The snapshot at `test/tui/__snapshots__/agent-prompt.txt` holds only the py_\*
lines and this extension's guidelines — pi's own boilerplate is pinned in
[shared/versions.env](../shared/versions.env) and is not this package's to keep.
Reword a guideline and the diff shows up in review, where a human reads it.

For everything the deterministic tier structurally cannot see — the payload on
the wire, which needs a real provider — there is
[shared/dev/pi-logger.ts](../shared/dev/pi-logger.ts), a dev-only extension that
writes JSONL:

```bash
npm run dev:log                       # scratch cwd; prints the log directory as PI_PY_LOG_DIR
jq -c 'select(.event=="context")' "$PI_PY_LOG_DIR"/*.jsonl   # payload size per call
jq -r 'select(.event=="prompt").systemPromptOptions.toolSnippets' "$PI_PY_LOG_DIR"/*.jsonl
```

Live cases load it automatically and `PI_TUI_KEEP=1` prints where it went, so a
failed live run leaves the model's actual inputs on disk rather than 2 kB of
screen. Load order decides which side of the context filter it sees; the header
of the file spells it out.

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
