# Pi Issue Tracker — internals

Implementation notes for the extension. User-facing docs are in the [top-level README](../README.md).

## Files

```
pi-issue-tracker/
  extensions/index.ts  → Extension factory (tool, commands, lifecycle, context injection, TUI)
  src/context.ts       → TrackerContext: paths, db, injected git/shell runners, clock
  src/config.ts        → Path resolution and the .pi/epic.json manifest
  src/rules.ts         → Pure decisions: gates, naming, commit messages, undo strategy
  src/git.ts           → Git plumbing over an injected runner
  src/epic.ts          → Epic lifecycle: start, commit, update, merge, cancel, undo
  src/database.ts      → SQLite schema and CRUD helpers
  src/related.ts       → Pluggable relevance strategy (related stories, learnings)
  src/types.ts         → Shared TypeScript interfaces
  src/README.md        → This file
  test/                → node --test suites; test/container/ runs them in the image
```

**`src/` must not import from `@earendil-works/*`.** `extensions/index.ts` is the only
pi-aware file: it builds a `TrackerContext` and delegates. That boundary is what lets
everything below it run under plain `node --test` against a temp repository, with no pi
runtime and no network.

## Data model

One table, `stories`, plus `app_state` (key/value) and `story_history` (append-only audit log).

Structure is carried by three independent fields:

- `parent_id` — the tree. A story with children is an **epic**: excluded from `get_next` and from ready-selection, and closed automatically by `closeCompletedParents` when its last child closes. `/plan-stories` materialises the goal itself as the root epic, which is what makes `parent_id` non-null in practice.
- `depends_on` — a DAG, stored as a JSON array (so it is not queryable in SQL). Gates `mark_in_progress` and `mark_done`.
- `next_id` — a linear suggestion chain. Closing a story promotes its `next_id` to `ready`.

Outcome fields are set when a story closes: `resolution` (enum, validated in TypeBox rather than by a SQL `CHECK` so the vocabulary can still change), `resolution_note`, and `learnings`.

## Things worth knowing

- **No migrations.** `INIT_SQL` is all `CREATE TABLE IF NOT EXISTS`, so it is a no-op against an existing database. Adding a column means deleting `.pi/stories.db`. `PRAGMA user_version` is unused and sits at 0.
- **No foreign keys.** Referential integrity is enforced in TypeScript: `wouldCreateCycle` on reparenting, child reparenting on delete, dependency repointing on `simplify`.
- **`openDb` returns a fresh handle per call.** It replaced a module-level singleton that ignored its argument after the first call, so one process could never hold two databases. Caching now lives in `extensions/index.ts`, keyed by path. The database runs in WAL mode with a 5 s busy timeout, because several worktrees or sessions can write one file.
- **`updateStory` builds its SET clause by interpolating object keys.** Safe today because every call site passes an object literal with `Story` keys, but it is a `${}` into SQL — do not spread untrusted tool params into it.
- **`story_history` is write-only.** Every create/update/delete logs a row and `getHistory` can read them, but nothing surfaces it yet.
- **Relevance is pluggable.** `RelatedStoriesStrategy` has two methods — `findRelated` (open stories) and `findLearnings` (closed stories carrying a learning). `keywordStrategy` scores word overlap plus structural boosts; swapping in embeddings means implementing the same interface.

## Git integration

Opt-in. Until `/start-epic` is run, no git side effect fires and the tracker behaves
exactly as it did before.

**Isolation comes from the branch, not the worktree.** `/start-epic <id>` creates
`epic/<id>-<slug>` from the current branch and records that branch as `base_branch`.
Recording it at start rather than reading `HEAD` at merge time is what lets the user
wander off-branch mid-epic safely. `main` and `master` are refused as bases.

**Nothing becomes unreachable.** Every destructive operation writes
`refs/pi/backup/<epic>/<operation>` first, so each has an inverse: `/undo-turn`,
`/undo-story`, `/undo-merge`, `/cancel-epic`. A ref costs 41 bytes.

**Merging runs in two steps, in this order:**

1. `git merge --no-ff <base_branch>` **into the epic branch** — conflicts surface where
   the agent is working, so it can resolve them.
2. `git merge --ff-only <epic branch>` into the base branch — cannot conflict, because
   step 1 already happened, and so cannot leave the user's branch half-merged.

Merging the epic straight into the base branch is the wrong direction and is not done.
Step 2 is always user-confirmed; `mark_done` is an agent decision and runs step 1 only.

**Constraints discovered in the SDK, worth not rediscovering:**

- `ctx.cwd` is a read-only getter, the built-in tools capture their directory at
  construction, and `process.chdir()` is inert. The only true relocation is
  `SessionManager.forkFrom` + `ctx.switchSession`, and those work only from a *command*
  handler. So the agent can never start an epic — the user must. Worktree mode (not yet
  implemented) depends on this.
- `pi.exec` never throws and never rejects on a non-zero exit; `code !== 0` is the only
  error signal. Both `GitRunner` implementations match that contract deliberately.
- Git work is serialized through one promise chain. Two transitions at once — an agent
  tool call while the story board is open — would race on `.git/index.lock`.
- `git status --porcelain` collapses an untracked directory into a single entry, so the
  commit size guard passes `--untracked-files=all`. Without it a stray build directory
  of ten thousand files counts as one.
- `stories.db` is added to `.git/info/exclude` at session start. The extension creates
  the file, so it takes responsibility for keeping it out of `git add -A` — otherwise
  every story commit sweeps up the tracker's own binary state and the dirty tree then
  blocks the merge. `info/exclude` is repo-local and untracked, so it needs no commit.
- `transitionStatus` is the single write path for `status`, and git effects hang off it.
  Two callers bypass it on purpose — `simplify` and `/plan-stories` — because both write
  status inside a SQLite transaction, which cannot stay open across a git subprocess.
  Both are bookkeeping rather than work starting or finishing, so neither has an effect
  to miss.

## Testing

`npm test` runs everything under `test/` with `node --test`. Node 24 strips TypeScript
types natively, so there is no build step and no test-framework dependency.

Each test builds its own repository under `mkdtemp` with `GIT_CONFIG_GLOBAL`,
`GIT_CONFIG_SYSTEM` and `HOME` redirected into it, so nothing reads or writes the
developer's real git configuration.

`npm run test:container` re-runs the same suites inside
[pi-container-distroless-node24](https://github.com/ocramz/pi-container-distroless-node24),
whose git is built with C builtins only and without perl, on a busybox userland, as an
unprivileged user. `test_git_capabilities.sh` runs first and gates the rest: if
`stash create` or `worktree` were missing there, `/undo-turn` and worktree mode would
need redesigning.

## Token accounting

`/plan-stories` is a *command*, not a tool. pi's footer counter sums `sessionManager.getEntries()` over assistant messages, tool results carrying `usage`, and compaction entries — a command's `modelRegistry.complete()` call appends none of those, and `ExtensionCommandContext` offers no way to report usage. So planning totals its own `response.usage` and renders it via `ui.setStatus`, which lands on the footer's extension-status line.

A live per-token counter is not reachable from an extension: `ModelRegistry` exposes only `complete()` (internally `stream(...).result()`, which discards the per-event `partial.usage`), and `BorderedLoader`'s label is fixed at construction. Both would need SDK changes.
