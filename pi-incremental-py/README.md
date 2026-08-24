# pi-incremental-py

An incremental computing kernel for Python, driven by the Pi agent over a
JSON-lines protocol. The DAG is recovered statically with `symtable`
(each cell's module-level defs and refs); editing a cell re-runs it and
its downstream, with content-addressed early cutoff so a re-run that
produces the same values recomputes nothing further.

## Semantics

- **Identity.** Cells get kernel-generated 6-char base32 ids (`k7x2qm`).
  An optional `name` is display metadata, never a lookup key. Execution
  order of independent cells is insertion order — never derived from ids.
- **Create vs. modify.** `add_cell` always creates (and returns the id);
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
      count = 0
  ```

  converges between incremental runs and `run_all` replays.
- **Builtin shadowing.** If a cell defines `len`, dependents of `len`
  get a real DAG edge and re-run when it changes.
- **Failure isolation.** A cell that raises leaves its dependents
  `pending` (skipped, not poisoned); `failing` lists the broken ones.
  Cell stdout/stderr is captured into each result's `output` field and
  never touches the protocol stream.

## Layout

- `py/reactive.py` — the core: `analyze` (symtable), `Notebook` (ids,
  staging with atomic rollback, versioned execution, topo-ordered run).
- `py/agent_kernel.py` — `CachingNotebook` (digest-keyed early cutoff),
  the `handle`/`serve` JSON-lines protocol.
- `py/env_kernel.py` — `EnvNotebook`: the installed-distribution set as a
  synthetic root of the DAG (all-or-nothing by design), kernel-aware
  `install`.

## Tooling

Stdlib-only by design. With nothing but a Python 3.12+ interpreter:

```bash
python3 -m unittest discover -s tests     # run the tests
python3 py/agent_kernel.py --serve        # speak the protocol on stdin/stdout
```

With [uv](https://docs.astral.sh/uv/) on the box:

```bash
uv run python -m unittest discover -s tests
uvx ruff check py tests && uvx ruff format --check py tests
```

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
{"tool": "install", "packages": ["cowsay"], "upgrade": false}
```

Mutating calls answer with `results` (per-cell `status` of
`ran | cached | error`, plus `value`, `error`, `output`, `seconds`),
`pending`, `failing`, and a `globals` summary; `add_cell`/`apply_edits`
also return the generated `id`/`created` ids. `inspect` returns the full
graph with `name`/`defines` beside every id, `stateful` flags, and the
namespace summary.
