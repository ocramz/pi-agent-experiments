# Persistence design

First use case: a data scientist / ML research engineer doing modeling and
experimentation, moving prototypes easily into production.

Guiding principle, inherited from the kernel itself: **the notebook is a
program, not a transcript.** Persistence is replay-first, snapshot-second.
The cell graph plus the environment are source of truth; live values are a
derived optimisation.

## Decisions

- Restore is **automatic and staged**: on kernel spawn the cell graph is
  rebuilt with everything `pending`; nothing executes until `run_all`.
- Warm restores stay pending too. A persistent value cache makes `run_all`
  fast, but nothing — cached or not — runs before the human says so.
- All extension state is project-scoped and gitignored.
- Multiple named notebooks per project; a notebook is a namespace.
- **Experiment branching and lineage are first-class**, not a later feature.
- The commit DAG is **real git**, not a reimplementation: **one non-bare
  repository per project** holds every notebook, its working tree *is* the
  checkpoint. Lineage, refs, divergence, and gc are git's; the kernel only
  maps cell graphs onto trees. Branches are project-wide (git's native
  unit); per-notebook divergence is expressed as a separate notebook, not
  a branch.

## The load-bearing observation

`CachingNotebook._key(cid)` is a hash of cell source plus the digests of all
inputs (transitively, via run-order key computation). **That key *is* the
lineage.** Same key, same computation — across restarts, notebooks, and
branches. Therefore:

- The persistent value cache is keyed by that hash and is **branch- and
  notebook-agnostic**. Branching never duplicates or invalidates cached
  values; a 40-minute model fit stays warm in every branch whose edits
  don't touch its inputs.
- Experiment branching needs only a commit DAG over cell-graph edits;
  values take care of themselves.

## Storage layout

`.pi/` is pi's own namespace for **checked-in, team-shared** agent
configuration (`settings.json`, installed packages). Lineage and the value
cache are private per-user working state and must not be committed — so
they live in a dedicated top-level directory, not under `.pi/`.

```
<project>/
  .pi/                     # pi's checked-in config — untouched by us
  .incremental/            # ours; one blanket .gitignore entry
    venv/                  # project-scoped venv the extension owns
    python-pin             # /py-python pin file
    notebooks/             # ONE git repo for the whole project
      .git/
      <notebook>/
        cells/<cid>.py     # one file per cell — working tree IS the checkpoint
        notebook.json      # {"order": [cids], "names": {cid: name}}
        env.lock           # python + pip freeze, updated on install commits
    cache/
      <key>.pkl            # shared across ALL notebooks and branches — NOT git
```

Why not `.pi/notebooks/`: pi documents `.pi/settings.json` as "shared with
your team" and the convention is to commit it. Hiding a git repo plus a
pickle cache inside a checked-in directory inverts the gitignore story —
we'd be carving exceptions out of shared space instead of ignoring private
space wholesale. A top-level `.incremental/` is one ignore line, keeps pi's
directory clean, and gives the user a visible home for their experiments
that pushes as a unit if they ever want the history elsewhere. Precedent:
pi's own issue-tracker already gitignores individual state files inside
`.pi/` rather than the directory — enumeration we avoid entirely.

Notebook names: `[a-z0-9-]+`; `main` is the default. Insertion order and
display names are kernel semantics, so they live in an explicit manifest
(`notebook.json`); cell sources are plain files.

## Why git for the DAG — and what stays ours

The originally sketched design (hash-chained `history.jsonl`, `branches.json`,
`HEAD`) cloned git's object model minus trees and merge. That is the worst
quadrant of git to reimplement: easy to get subtly wrong (atomic refs, gc),
nothing gained (we never merge). Mapping instead:

| design element | git |
|---|---|
| append commit per mutation | write changed files, `git add -A`, `git commit -m "op … \n\n<message>"` |
| replay ops from root on restore | **deleted** — read `cells/*.py` + `notebook.json` at HEAD, stage pending |
| branch / checkout / divergence | `git branch` / `git checkout` / `git merge-base` |
| lineage id in export header | real git sha |
| orphaned-history gc | git's own |

Bonuses: the lineage repo is hand-editable and pushable — an ML researcher
can branch outside pi. Restore validates hand-broken trees with warnings
instead of corrupting a journal.

Implementation: subprocess plumbing only, no Python dependency — the kernel
gains a *soft* dependency on the git binary (persistence unavailable without
it; in-memory unaffected). Commits carry `-c user.name/email` so unconfigured
environments and the test tier's redirected `GIT_CONFIG_*` both work. Commit
latency (~10–30ms) is fine at human/agent edit pace; a batched `apply_edits`
is one commit.

Explicitly NOT git: the Layer 2 value cache (churning binary blobs — git is a
poor cache, same reason pip/ccache don't use it) and every kernel semantic
(pending restore, warm run_all, stateful convergence, export, routing).

## Layer 1 — checkpoint semantics on git (correctness + lineage)

- Every successful mutation writes the changed files and commits. Ops cover
  cell edits **and tracked installs** (installs invalidate importing cells,
  so they are lineage). A batched `apply_edits` is one commit. The commit
  message carries the op as a trailer plus the optional human/agent
  `message` — annotation is metadata; state recovery never parses messages.
- Restore = instantiate the HEAD tree into staged cells (pending). Nothing
  walks history; `git log` is for display and lineage only.
- Branch/checkout rebuild the staged graph from the new ref; the live
  namespace is untouched until `run_all`.
- Non-goal: **no merge.** Branch, compare, cherry-pick a cell by hand.
  Merging cell graphs with stateful cells is a research project.

## Restore path

1. Kernel for notebook `N` spawns → reads `.incremental/notebooks/N/`,
   instantiates the HEAD tree into staged cells, everything `pending`.
2. Env check: `env.lock` vs current `env_digest()`. Drift is reported in
   the restore response (`env_drift: {missing, extra}`) — warn, never fail;
   offer reinstall.
3. `inspect` works immediately: the agent sees the full graph, names, and
   pending state before anything runs.

## Layer 2 — persistent value cache (warm `run_all`)

Nothing unpickles at restore. The cache hooks the existing freshness check
in `CachingNotebook.run()`:

- A pending cell whose key has `.incremental/cache/<key>.pkl` is **warm**:
  defs are loaded from pickle, result is `cached`, early cutoff propagates
  downstream exactly as in-memory today.
- Every successful `_execute` writes the cell's committed defs. Pickle
  failures are skipped silently (same degradation as `digest -> None`).
- **Required fix:** `digest()` returning `None` currently produces a
  time-based "never cache" key. For persistence, unhashable inputs must key
  on a per-notebook session salt, so a restarted process never falsely
  matches a live socket's key.
- Stateful accumulators converge: a `count = count + 1` cell keys on its
  previous committed value; if that value was restored, the key matches and
  the cell is warm — restore behaves like incremental, not like a divergent
  replay. Needs an explicit test.
- Eviction: orphaned keys accumulate; simple size cap / LRU, `/py gc` later.

## Layer 3 — export (prototype → production)

Two formats, because the personas below need different slices of the state:

**Snapshot** — a single JSON file holding the tip cell graph plus enough
environment to reconstruct it:

```json
{
  "format": "incremental-notebook/1",
  "notebook": "featurization",
  "exported_from": {"commit": "b3f9…", "branch": "main"},
  "python": "3.12",
  "env": ["numpy==2.1.3", "…"],
  "cells": [
    {"id": "k7x2qm", "name": "load", "src": "…", "order": 0}
  ]
}
```

**Lineage bundle** — the full commit DAG as one file, via git's native
single-file history transport (`git bundle`; verify CLI details at
implementation). Preserves branches and commit messages — the dead ends,
not just the working tip. Optionally filtered to one notebook's history.

Values never travel in either format: pickle is pinned to the Python
version, platform, and library versions that produced it, so the value
cache is machine-local by nature. `env.lock` is the reproducibility
contract; the recipient's content-addressed cache warms on their first
`run_all`.

Separately, `/py export <file.py>` keeps its existing role: the *production*
path. Plain module, cells in topo order as labelled sections, trailing
expressions dropped, stateful cells keep their from-scratch-safe idiom.
`requirements.txt` from `env.lock`, HEAD commit sha in the export header
so a production artifact names its exact lineage. The module is a shipping
destination, not a collaboration format — it cannot be re-imported as a
notebook.

## Collaboration & export formats

Who uses the serialized notebook, and which slice of the state they need:

| persona | what travels | format |
|---|---|---|
| **Maya** — solo researcher, machine-hopping (laptop → GPU box) | her own lineage, both ends | git **remote** on the lineage repo (primary); bundle as fallback |
| **Priya** — DS handing a prototype to ML engineering | the dead ends too: branches + commit messages | lineage **bundle** |
| **Tom** — tech lead reviewing an experiment | history as narrative; must not touch his own notebooks | bundle, imported as new branch/notebook |
| **Aisha** — educator / open-science author | tip + env only; history is noise to her audience | **snapshot** JSON |
| **Diego** — on-call engineer debugging a prod model | the exact graph at the sha in the export header | lineage repo **reachable somewhere durable** (a pushed remote), not a file |
| **audit/compliance** (regulated) | complete immutable history, arguably signed | git substrate serves this; named non-goal for now |

Two lessons the personas force:

- **Sync ≠ collaboration.** Maya's multi-machine need is served by an
  ordinary git remote on the lineage repo; the file formats are the
  fallback when no shared remote exists. Don't conflate the two.
- **Priya's handoff is why history-preserving export exists at all.** A
  tip-only snapshot silently deletes the rejected branches — often the
  most valuable knowledge in a handoff. Hence two formats, not one format
  with a flag.

### Import semantics

- Import **never overwrites or merges**. Foreign cells always land as a
  *new* notebook (snapshot) or new branch/notebook (bundle) — never
  in-place into the recipient's existing notebooks.
- Cell ids are preserved **verbatim**. Id stability across machines is
  what makes lineage meaningful; the notebook namespace absorbs any
  collision with the recipient's own notebooks.
- Imported cells land **staged and pending**, exactly like restore. Env
  drift between the snapshot's `env.lock` and the recipient's venv is
  reported, never fatal.

### Trust & secrets

- **Importing a notebook is importing code.** The staged/pending contract
  is the safety mechanism: the recipient inspects cells via `inspect`
  before any `run_all` executes them.
- Export **warns about secrets and local paths** — cells routinely contain
  API keys and absolute paths. Scrubbing is the exporter's job in v1; the
  tool surfaces the warning, it does not rewrite sources.

### Remote-push workflow (multi-machine & production)

The lineage repo is a real git repo, so a team that wants shared history
adds a remote and pushes it — **separately from the code repo**. Two
repos, two rhythms: the code repo is shared and curated, the lineage repo
is shared-but-voluminous. This is the primary multi-machine story (Maya)
and a production prerequisite (Diego): a shipped module's header sha must
be reachable, so the lineage repo needs a durable home before anything
goes to production. Snapshot/bundle export is the fallback when no remote
exists.

### Open questions

- **Bundle filtering**: does Priya need a single notebook's history
  carved out of the project repo, or is whole-project bundling enough?
  (git bundles whole refs; per-notebook filtering may mean exporting a
  rewritten linear history.)
- **Audit/signing**: signed lineage commits for regulated environments —
  git supports it; explicitly out of scope for v1.
- **Snapshot scrubbing**: automated secret detection on export, or warning
  only? v1 warns.

## Multi-notebook routing

One kernel subprocess **per active notebook**: separate Python namespaces
anyway, and a training OOM in one notebook doesn't kill the others. The
extension keeps a name → Kernel map, spawning lazily with the notebook's
state dir passed at spawn (`--state-dir`). Agent tools gain an optional
`notebook` param defaulting to the session's current notebook.

Commands: `/py notebook <name>` (switch/create), `/py notebooks` (list).

Checkout semantics: switching branches rebuilds the staged graph but does
not touch the live namespace until `run_all` — consistent with warm-stays-
pending. Hazard: staged branch ≠ live namespace is a confusing intermediate
state, so `inspect` reports `checked_out` vs `loaded` when they differ.

## Protocol additions

```json
{"tool": "commit_log"}
{"tool": "branch", "name": "rf-sweep"}
{"tool": "checkout", "name": "main"}
{"tool": "branches"}
{"tool": "restore"}
{"tool": "export", "path": "model.py"}              // production module
{"tool": "export_notebook", "path": "nb.json"}      // snapshot
{"tool": "export_history", "path": "nb.bundle"}     // lineage bundle
{"tool": "import_notebook", "path": "nb.json", "as": "name"}
```

All mutation responses gain `"commit": "<id>"`. Mutation ops accept an
optional `"message"`.

## Build order

1. **Commit DAG + staged restore** — crash recovery, branching, lineage
   metadata; no value cache yet. Forces the commit-message surface early.
2. **Persistent value cache** — warm `run_all`, session-salt fix for
   unhashable digests, stateful-cell convergence test.
3. **Multi-notebook routing** — kernel map, `/py notebook(s)`.
4. **Production export + snapshot export/import** — `/py export` module
   emission and the JSON snapshot round-trip.
5. **Lineage bundle export/import** — `git bundle` transport; remote-push
   workflow documented alongside.

Each step ships useful on its own; later steps read from earlier ones.
