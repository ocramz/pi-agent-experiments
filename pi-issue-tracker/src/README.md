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
  src/worktree.ts      → Worktree plumbing and database/git reconciliation
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

**Isolation comes from the branch; the worktree adds to it.** `/start-epic <id>` creates
`epic/<id>-<slug>` from the current branch and records that branch as `base_branch`.
Recording it at start rather than reading `HEAD` at merge time is what lets the user
wander off-branch mid-epic safely. `main` and `master` are refused as bases. A worktree
adds *filesystem* isolation on top, which is why it is a mode and not the foundation.

**Nothing becomes unreachable.** Every destructive operation writes
`refs/pi/backup/<epic>/<operation>` first, so each has an inverse: `/undo-turn`,
`/undo-story`, `/undo-merge`, `/cancel-epic`. A ref costs 41 bytes.

**Merging runs in two steps, in this order:**

1. `git merge --no-ff <base_branch>` **into the epic branch** — conflicts surface where
   the agent is working, so it can resolve them.
2. Fast-forward the base branch onto the epic branch — cannot conflict, because step 1
   already happened, and so cannot leave the user's branch half-merged.

Merging the epic straight into the base branch is the wrong direction and is not done.
Step 2 is always user-confirmed; `mark_done` is an agent decision and runs step 1 only.

Step 2 moves the branch one of two ways, and which one matters:

- **`git merge --ff-only` in the main checkout** whenever that checkout should end up
  showing the merged result — always in branch mode, and in worktree mode when the main
  checkout already happens to be on the base branch.
- **`git update-ref` with a compare-and-swap** otherwise, after checking ancestry
  explicitly with `merge-base --is-ancestor`. Checking the base branch out just to merge
  it would drag a session somewhere it did not ask to go, and with concurrent epics that
  session belongs to somebody else. `checkCanMerge` refuses outright when a *different*
  worktree holds the base branch, because moving it would rewrite what that session sees.

### Concurrency, and why every lookup is session-scoped

Branch mode owns the main checkout's HEAD, so at most one branch-mode epic can exist.
Worktree mode owns only a directory, so any number can run at once — each in its own pi
session, all sharing the main repository's `stories.db`.

**There is therefore no such thing as "the" active epic**, and nothing session-scoped may
ask for one. `resolveSessionEpic` answers "which epic is *this* session working on" from
the session's own directory: a linked worktree resolves through `getEpicBranchByPath`,
the main checkout resolves to the branch-mode epic. `extensions/index.ts` caches the
resulting **id** and re-reads the row on every use, so a state change made by another
session is seen immediately.

Resolution is by path, deliberately not by current branch. The design lets the user wander
off the epic branch mid-epic — that is the whole reason `base_branch` is recorded at start
— and branch-based resolution would lose the epic the moment they did.

Two invariants hold this together:

- **`epic.path` is non-null exactly while the worktree exists.** It is cleared when the
  worktree is removed, so `epicCwd` falls back to the main repository and `/undo-story`
  against a merged epic still works.
- **The stored path is the one git resolved**, taken from `rev-parse --show-toplevel`
  after creation rather than the one we asked for. The row is looked up by string
  equality against that same command, and git reports real paths — on macOS, where every
  `/tmp` path is reached through a symlink, storing the requested path makes the lookup
  silently return null.

`findMissingWorktrees` reconciles the two views at `session_start`. An active row whose
directory is gone — a crashed session, a manual `rm -rf` — is marked cancelled silently,
which loses nothing because the branch and the backup refs are untouched. A managed
directory no active epic claims is only *reported*: deleting a directory is not a decision
to make on the user's behalf, and a blocking dialog during startup would stall every
session behind a question most of them do not need to answer.

### Ref retention

Backup refs are the safety net, so nothing is pruned on its own initiative. Checkpoints
are the exception: `turn_end` writes one per turn with a dirty tree, only the newest is
ever read, and the tail is pruned to twenty on each write. `/merge-epic` and
`/cancel-epic` *offer* to prune the rest, and always keep the ref the operation's own undo
depends on — `pre-merge` and `pre-cancel` respectively.

**Constraints discovered in the SDK, worth not rediscovering:**

- `ctx.cwd` is a read-only getter, the built-in tools capture their directory at
  construction, and `process.chdir()` is inert. The only true relocation is
  `SessionManager.forkFrom(sessionFile, targetCwd)` + `ctx.switchSession`, and those work
  only from a *command* handler. So the agent can never start an epic — the user must.
- **A `withSession` callback runs in the old closure.** By then the old session has
  emitted `session_shutdown`, the runtime has been torn down and rebound, and the new
  extension instance has already had its `session_start`. Anything session-bound captured
  beforehand — `ctx`, `ctx.sessionManager` — throws if touched. Only plain strings survive
  the switch, which is why every database write happens *before* it and `finishMerge`
  re-resolves the tracker rather than closing over one.
- **`ui.notify` is lost across a session switch.** The replacement repaints the TUI from
  the new session's transcript, and a notification was never part of one. Anything said
  after a relocation — including failures — goes through `report`, which sends a displayed
  message instead when the context can. A silently swallowed "the merge did not happen" is
  the worst outcome available here, so errors take the same route as successes.
- **A session with no assistant message has no file.** `SessionManager._persist` waits for
  one before flushing anything, and slash commands produce no session entries, so a session
  that has only run `/plan-stories` and `/start-epic` has never been written. `forkFrom`
  refuses it, and worktree mode says so rather than inventing a session: the worktree and
  the epic row both exist, so opening pi in that directory picks the epic up. This is also
  why the one interactive test of relocation has to spend a model turn first.
- `pi.exec` never throws and never rejects on a non-zero exit; `code !== 0` is the only
  error signal. Both `GitRunner` implementations match that contract deliberately.
- Git work is serialized through one promise chain, which orders *this* process only.
  Concurrent worktree epics mean concurrent pi processes on one repository, so
  `withLockRetry` wraps the runner and retries a handful of times when git reports a
  contended `.lock`. That is mitigation, not coordination: it turns a rare hard failure
  into a pause, and does not make two sessions agree about anything. Most operations touch
  only their own worktree's index and cannot collide at all.
- `git status --porcelain` collapses an untracked directory into a single entry, so the
  commit size guard passes `--untracked-files=all`. Without it a stray build directory
  of ten thousand files counts as one.
- `stories.db` is added to `.git/info/exclude` at session start. The extension creates
  the file, so it takes responsibility for keeping it out of `git add -A` — otherwise
  every story commit sweeps up the tracker's own binary state and the dirty tree then
  blocks the merge. `info/exclude` lives in the common git dir, so one write covers every
  worktree, and it is untracked, so it needs no commit.
- `transitionStatus` is the single write path for `status`, and git effects hang off it.
  Two callers bypass it on purpose — `simplify` and `/plan-stories` — because both write
  status inside a SQLite transaction, which cannot stay open across a git subprocess.
  Both are bookkeeping rather than work starting or finishing, so neither has an effect
  to miss. Any *new* status writer must go through `transitionStatus`.

### Limits worth stating plainly

- **The branch guard is a speed bump, not a boundary.** `isBranchEscapingCommand` catches
  `git switch`, `git checkout <branch>`, `git reset --hard`, `git branch -D` and
  `git worktree remove` in agent bash. It will not catch every route out of the branch,
  and it cannot — it exists to stop the likely accident, not an adversary.
- **`git add -A` still commits whatever is not ignored.** The size guard (500 files,
  50 MB) and the automatic `stories.db` exclude cover the common accidents; an untracked
  secret smaller than that will still be committed.
- **No schema migrations.** See "Things worth knowing" above. `epic_branches.setup` is a
  JSON column precisely so new fields never need one.
- **`"type": "module"`** was added to `package.json` to clear a Node warning. Low risk —
  no `.js` files, source is already ESM — but it does change module resolution for the
  published package.

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
need redesigning. The image is pinned by digest in two places that must move together —
`TEST_IMAGE` in the root `Makefile` and `IMAGE` in `.github/workflows/test.yml`.

`npm run test:tui` drives pi's real TUI through a pty. It is the only tier that reaches
the ten `registerCommand` handlers, the story board's key handling, and pi's session
relocation — none of which exist outside a running pi. See
[test/tui/README.md](../test/tui/README.md).

### Known limitations of the live tier

`test/container/test_extension_live.sh` drives a real model against the extension, because
hooks and tools have no other entry point. Two consequences are worth stating rather than
discovering:

- **It costs money and is not deterministic.** It defaults to a cheap model and asserts
  only on durable state — rows in `stories.db`, refs, `.git/info/exclude` — never on
  assistant prose.
- **Its prompts are load-bearing.** Both end with an explicit instruction to stop, and the
  guard case adds "do not investigate further", because otherwise the model keeps using
  the bash tool after the assertion is already satisfied. That is prompt engineering
  inside a test, which is fragile by nature.

The fix for both is a scripted mock provider: pi supports `pi.registerProvider` with an
`openai-completions` API, so a local server returning a fixed sequence of tool calls would
make the tier free, deterministic, and runnable on forked pull requests. It is not built.

## Packaging

The package is installable with `pi install npm:pi-issue-tracker`. Three things about the
manifest are easy to get wrong:

- **`pi.extensions` is the entry point**, not `main` or `exports`. There is no build step
  and nothing compiled: pi loads the raw `.ts` through jiti, and `engines.node >= 24`
  records the type-stripping requirement that follows from shipping source.
- **Core pi packages go in `peerDependencies` at `"*"`**, per pi's own docs, and *also* in
  `peerDependenciesMeta` as `optional`. Without the optional markers npm 7+ auto-installs
  them: a measured **239 MB** of `node_modules` beside a package that has no runtime
  dependencies at all. With them, nothing is installed.
- **`files` is an allowlist.** `test/`, `tools/` and `tsconfig.json` are deliberately
  outside it; the published tarball is fourteen files.

## Token accounting

`/plan-stories` is a *command*, not a tool. pi's footer counter sums `sessionManager.getEntries()` over assistant messages, tool results carrying `usage`, and compaction entries — a command's `modelRegistry.complete()` call appends none of those, and `ExtensionCommandContext` offers no way to report usage. So planning totals its own `response.usage` and renders it via `ui.setStatus`, which lands on the footer's extension-status line.

A live per-token counter is not reachable from an extension: `ModelRegistry` exposes only `complete()` (internally `stream(...).result()`, which discards the per-event `partial.usage`), and `BorderedLoader`'s label is fixed at construction. Both would need SDK changes.
