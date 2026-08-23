# Git integration — status, remaining work, caveats

Working document for the git lifecycle being added to `pi-issue-tracker`. Design rationale
lives in [src/README.md](src/README.md#git-integration); this file tracks what is built, what
is actually proven, and what is left.

Last updated: 2026-08-23.

---

## The design in one paragraph

Each epic gets its own branch. Isolation comes from the **branch** (which protects the base
branch), reproducibility from a **declared `.pi/epic.json` manifest**, and undo from **git
refs** — none of which require the working directory to move. A worktree adds *filesystem*
isolation on top and is therefore an opt-in mode, not the foundation. Git integration is
opt-in overall: until `/start-epic` runs, no side effect fires and the tracker behaves
exactly as it did before.

---

## Status at a glance

| Area | State |
|---|---|
| Phase 0 — testable foundation | **Done**, committed (`ee88886` "parametric git and db layer") |
| Phase 1 — branch mode, end to end | **Done**, uncommitted in the working tree |
| Phase 2 — worktree mode | **Not started** |
| Host test suite (`npm test`) | 85 tests, all passing |
| Type-check (`npm run typecheck`) | Clean, against pi's real declarations. Runs on the host, in the container and in CI |
| Container tests (`make check`) | 12 + 5 + 12 passing, nested podman, ~20s |
| Coverage of `extensions/index.ts` | Hooks and the `story` tool, live. Commands and the board: the interactive tier |
| Interactive suite (`make test-tui`) | 38 cases, all passing, ~90s. pi's real TUI through a pty |

---

## What is built

### Phase 0 — testable foundation (committed)

- `src/context.ts` — `TrackerContext`: paths, db, injected `GitRunner` / `ShellRunner`, clock,
  notify. Replaced three pieces of module-level state.
- `src/config.ts` — `resolvePaths` with an overrides → env → `.pi/settings.json` → derived
  chain, plus `readManifest`. Repo root comes from `git rev-parse --git-common-dir`, so a
  linked worktree resolves to the *main* checkout's `stories.db`.
- `src/rules.ts` — pure decisions, no I/O: `checkCanStartEpic`, `epicBranchName`,
  `storyCommitMessage`, `chooseUndoStrategy`, `checkStageSize`, `isBranchEscapingCommand`.
- `src/git.ts` — plumbing over an injected runner; `createLocalGitRunner` for tests.
- `src/database.ts` — `openDb` replaced a singleton that ignored its argument after the first
  call (one process could never hold two databases). WAL + `busy_timeout`. Two additive
  tables: `epic_branches`, `story_commits`.
- `extensions/index.ts` — `transitionStatus` as the single write path for `status`;
  `rollUpEpics` → `closeCompletedParents`.
- `.gitignore`, `tsconfig.json`, CI workflow, container harness skeleton.

### Phase 1 — branch mode (uncommitted)

Working tree: `src/epic.ts` and `test/epic.test.ts` are new; `extensions/index.ts`,
`src/context.ts`, `src/git.ts`, `src/README.md`, `test/helpers/repo.ts` are modified.

- **`src/epic.ts`** — `startEpic`, `commitStory`, `updateFromBase`, `mergeIntoBase`,
  `cancelEpic`, `undoStory`, `undoMerge`, `runSetup`, `ensureDatabaseIgnored`,
  `findEpicForStory`, `epicCwd`.
- **Commands** — `/start-epic`, `/merge-epic`, `/cancel-epic`, `/undo-story`, `/undo-merge`,
  `/undo-turn`.
- **Hooks** — `turn_end` writes a `stash create` checkpoint under
  `refs/pi/checkpoint/<epic>/<ms>`; `tool_call` blocks branch-escaping bash while an epic is
  active; `before_agent_start` injects an `>>> EPIC BRANCH` section.
- **Git effects** hang off `transitionStatus` and are serialized through one promise chain,
  so two transitions cannot race on `.git/index.lock`.

Merging is two steps and always in this order: `merge --no-ff <base>` **into the epic branch**
first, so conflicts land where the agent is working; then `merge --ff-only` into the base
branch, which cannot conflict. Step 2 is user-confirmed and never runs on the agent's say-so.

---

## What is actually proven

Stated precisely, because several of these were verified by an unusual route.

| Claim | How it was checked | Confidence |
|---|---|---|
| Every git operation the design needs exists in the image's git 2.39.5 — `stash create` (and it leaves the working tree untouched), `worktree add/list/remove`, `update-ref`, `for-each-ref`, `merge --ff-only`, `revert --no-commit`, `rev-parse --path-format=absolute --git-common-dir` | Extracted the image rootfs and ran **the image's own git binary** through its own loader against a scratch repo | High for the binary; **does not** cover busybox userland or uid 65532 |
| A linked worktree resolves to the main repo's `stories.db` | `test/config.test.ts`, real `git worktree add` | High |
| Epic lifecycle behaves: one commit per story, clean tree makes none, size guard refuses, failing `verify` commits nothing, conflicts reported by path, `--ff-only` refuses when the base moved, undo resets at the tip and reverts off it, `undoMerge` restores byte-identically | `test/epic.test.ts`, 30+ cases against temp repos | High |
| Types resolve against pi's real declarations rather than degrading to `any` | `npm run typecheck` with deliberate errors injected against a pi type, a local type and a node type, to confirm each fails. Not a formality: mapping tsconfig's `paths` to a package *directory* leaves every pi type `any` under ESM resolution, and that mistake type-checks clean | High |
| The extension loads and builds its context in a real pi 0.84.2 session | One headless `pi --mode json -e extensions/index.ts` run | Medium — see caveats |

---

## Remaining work

### Phase 2 — worktree mode

1. **`src/worktree.ts`** — `git worktree add -b <branch> <worktreeRoot>/<name> <base_branch>`,
   `list --porcelain`, `remove`; `findMissingWorktrees` reconciliation.
   `worktreeRoot` defaults outside the repo on purpose: a worktree under `<repo>/` makes every
   `rg`, `tsc --build` and test glob descend into a second full copy of the tree.
2. **`/start-epic <id> --worktree`** — currently rejected with an explicit "not implemented"
   message. Needs: create the worktree, copy the manifest's `copy` entries (gitignored files
   like `.env` that a worktree does not carry), export `caches`, run `setup` behind a
   `BorderedLoader`, then relocate the session.
3. **Session relocation** — `SessionManager.forkFrom(sessionFile, path)` then
   `ctx.switchSession(newFile, { withSession })`. Only reachable from a *command* handler.
   All post-switch work must go inside `withSession`; the outer `pi`/`ctx` go stale and the
   runner throws if they are used. Follow `examples/extensions/handoff.ts:177-186`.
4. **`/merge-epic` in worktree mode** — switch the session back to the main repo **first**,
   then step 2, `git worktree remove`, delete the branch. Removing the directory the session
   is standing in breaks the session.
5. **`findMissingWorktrees` on `session_start`** — reconcile `git worktree list --porcelain`
   against `epic_branches`; a missing path marks the row `cancelled`, a managed path with no
   row is offered for removal. Handles crashed sessions and manual `rm -rf`.
6. **`test/worktree.test.ts`** — including two concurrent epics not interfering, and the
   database-anchoring guard from inside a worktree.

### Test tiers

All four tiers now run. `make check` at the repo root starts a devcontainer with the flags
nested podman needs and runs everything: the host suite, the interactive tier, the git
capability probe, the in-image unit run, and the live extension suite (85 / 38 / 12 / 5 / 10).

7. ~~**Tier 4 — the command handlers.**~~ **Done.** `test/tui/` drives pi's real TUI and covers
   all ten commands and the story board in 38 cases. The pty this needed is `script(1)`:
   `cli-testing-library` spawns with pipes, and pi resolves `!stdinIsTTY || !stdoutIsTTY` to
   print mode, where a slash command is never parsed. `script` allocates the pty; the library
   keeps the pipes. See [test/tui/README.md](test/tui/README.md).
8. **A scripted mock model** would make the live tier deterministic and free. Today it drives a
   real cheap model (`deepseek/deepseek-v4-flash`) and asserts on durable state — rows in
   `stories.db`, `refs/pi/checkpoint`, `.git/info/exclude` — precisely because model output is
   not dependable. A mock returning a scripted sequence of tool calls (`story(create)` →
   `story(mark_in_progress)` → edit → `story(mark_done)`) would let the suite assert on an exact
   commit sequence instead.

### Smaller known gaps

9. **Checkpoint refs accumulate.** `turn_end` writes one ref per turn with a dirty tree and
   nothing prunes them. A long epic leaves hundreds under `refs/pi/checkpoint/<epic>/`. Needs a
   retention policy (keep last N) and cleanup on merge/cancel.
10. **Backup refs are never cleaned up either.** Deliberate for now — they are the safety net —
    but `/merge-epic` and `/cancel-epic` should eventually offer to prune the epic's refs.
11. **`/undo-merge` without an id picks by a second-resolution clock.** Two defects, found while
    building a fixture for it:
    - `epic_branches.created_at` and `updated_at` default to `strftime('%s', 'now') * 1000` —
      millisecond *scale*, second *resolution*. Two epics created in the same second hold
      identical timestamps, and `getEpicBranchesByState`'s `ORDER BY created_at ASC` then falls
      back to rowid, which is `epic_id`. Selection between them is effectively arbitrary. The
      same defaults ignore `TrackerContext.now`, so tests cannot control the clock either.
    - Ordering by `created_at` answers "which epic started last", where `/undo-merge` wants
      "which epic merged last". They coincide today only because `checkCanStartEpic` allows one
      active epic at a time, so epics merge in the order they were created — the bug is real but
      currently unreachable through the commands.

    Fix both together: millisecond timestamps written by the caller through `ctx.now`, and
    selection ordered by `updated_at`. Exact when given an id, so there is no urgency. An
    interactive case for this was written and then removed — its outcome depended on sub-second
    timing, which makes it a unit test, and only after the ordering is fixed.
12. **The manifest's `copy` field is unused** in branch mode — it only matters for worktrees.
13. **CI pins `:latest`.** Should be a digest — the git capability probe is only meaningful
    against a known userland. `TEST_IMAGE` in the root `Makefile` and `IMAGE` in
    `.github/workflows/test.yml` are the two places to change together.
14. **The live suite's prompts are load-bearing.** Both end with an explicit instruction to stop,
    and the guard case adds "do not investigate further", because without them the model keeps
    using the bash tool after the assertion is already satisfied. That is prompt engineering
    inside a test, which is fragile by nature; a scripted mock (item 8) is the real fix.

---

## Caveats and risks

### Coverage gaps

**`extensions/index.ts` is covered end to end, by two suites that reach it from opposite ends.**
`test/container/test_extension_live.sh` drives a real model against the extension inside the
distroless image and asserts on the database and on git refs: `session_start` creating the DB
and excluding it, `before_agent_start` injecting the epic context, the `story` tool's `create`
path, the `tool_call` branch guard blocking an escape, and `turn_end` checkpointing a dirty
tree. `test/tui/` drives the other half — the ten `registerCommand` handlers and the board's key
handling — through a real TUI in a pty.

What neither reaches: the **worktree** paths, which are not built (Phase 2), and pi's
**session relocation**, which only a worktree-mode command would exercise.

### Environment notes

- **Nested podman works, with flags.** Running the container suite from inside the devcontainer
  needs `--security-opt unmask=/proc/*`, `seccomp=unconfined`, `label=disable` and
  `--device /dev/net/tun`, plus a named volume for the inner image store. The root `Makefile`
  carries them, each annotated with the failure it prevents. `--cap-add SYS_ADMIN` makes things
  worse, not better. The earlier note here — that podman could not create containers at all —
  was a missing `/dev/net/tun` and podman's own `/proc` masking, not a hard sandbox limit.
- **The host mount arrives as root-owned 0600.** Podman machine's virtiofs presents every host
  file that way on macOS regardless of its real mode, so a read-only bind of the checkout is
  unreadable to the image's uid 65532. `stage_pkg` in `test/container/lib.sh` copies the package
  and normalises modes before mounting it; without that the in-image suite copies nothing and
  passes vacuously, which is exactly what it used to do.
- **The container suite makes paid model calls** on every run — that is the only way to reach
  the extension. It defaults to `deepseek/deepseek-v4-flash` to keep that cheap, and refuses to
  run without `OPENROUTER_API_KEY` rather than skipping the tier quietly. A full `make check`
  takes about 20 seconds.
- **A live test needs a time budget.** Every pi call in the live suite is wrapped in `timeout`
  (`PI_TIMEOUT`, 240s). Without it one run blocked for twenty minutes on
  `grep -r "strand its work" /`: the branch guard had blocked the model, and it went looking
  through the whole filesystem for the source of the message. A model holding a bash tool has
  no natural stopping point, so an unbounded live test is one curious model away from wedging
  CI.
- **`node_modules/` here is symlinks** into the global pi install so `tsc` can resolve
  `@earendil-works/*`. It is gitignored, and a real `npm install` replaces it.

### Design consequences worth remembering

- **The agent can never start an epic.** `ctx.cwd` is a read-only getter, built-in tools capture
  their directory at construction, and `process.chdir()` is inert; the only true relocation is
  `SessionManager.forkFrom` + `ctx.switchSession`, which work solely from a command handler.
  `/start-epic` is a user action by necessity, not by preference.
- **Two callers bypass `transitionStatus` on purpose** — `simplify` and `/plan-stories`. Both
  write status inside a SQLite transaction, which cannot stay open across a git subprocess, and
  both are bookkeeping rather than work starting or finishing. Each says so at the call site.
  Any *new* status writer must go through `transitionStatus`.
- **Git serialization is per-process.** Two pi sessions on the same repository are not
  coordinated and could still collide on `.git/index.lock`. The database is safe (WAL +
  `busy_timeout`); git is not.
- **The branch guard is a speed bump, not a boundary.** `isBranchEscapingCommand` catches
  `git switch`, `git checkout <branch>`, `git reset --hard`, `git branch -D` and
  `git worktree remove` in agent bash. It will not catch every route out of the branch, and it
  cannot — it exists to stop the likely accident, not an adversary.
- **`git add -A` still commits whatever is not ignored.** The size guard (500 files / 50 MB) and
  the automatic `stories.db` exclude cover the common accidents; an untracked secret smaller
  than that will still be committed.
- **No schema migrations.** `INIT_SQL` is all `CREATE TABLE IF NOT EXISTS`, so a new *table* is
  safe but a new *column* means deleting `.pi/stories.db`. The `setup` JSON column on
  `epic_branches` exists to absorb new fields without one.
- **`"type": "module"`** was added to `package.json` to clear a Node warning. Low risk — no `.js`
  files, source is already ESM — but it does change module resolution for the published package.

---

## Running things

```bash
npm test                 # host suite, 85 tests, no dependencies (Node 24 strips types)
npm run typecheck        # needs node_modules resolvable; see caveats
npm run test:container   # needs a working container engine; exits 127 if it cannot run one
```

The container run executes `test_git_capabilities.sh` first and stops if it fails: if
`stash create` or `worktree` were unavailable in that userland, `/undo-turn` and Phase 2 would
need redesigning, and every later failure would be noise.

### Manual check for branch mode

```bash
git init && git commit --allow-empty -m initial && git switch -c feat/scratch
# /plan-stories a small goal, then:
#   /start-epic <id>          → refuses on main, refuses on a leaf story,
#                               offers to carry a dirty tree
#   close two stories         → one commit each, correctly titled
#   ask the agent to `git switch main` in bash → blocked
#   /merge-epic               → confirms, fast-forwards feat/scratch
#   /undo-merge               → restores feat/scratch exactly
```
