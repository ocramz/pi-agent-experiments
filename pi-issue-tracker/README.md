# Pi Issue Tracker

An extension for **pi** that turns a high-level goal into a linked, tracked set of user stories stored in a project-local SQLite database.

## Features

- **Plan from a goal** — `/plan-stories <goal>` breaks down work into user stories using the active model. The goal itself becomes a root **epic**, every generated story is parented to it, and it is set as the big-picture story automatically.
- **Story tool** — The agent can create, update, delete, list, search, simplify, reorder, and mark stories done.
- **Hierarchy** — Stories form a tree. A story with children is an epic: it is never handed out as work, and it closes automatically once its last child closes. The board, the markdown export, and the injected context all show the tree.
- **Context injection** — Before every turn, the extension injects a focused story context showing: (1) the next ready story to work on and the epic it belongs to, (2) the top-level big-picture story, (3) the story just completed in the previous turn, (4) other in-progress stories, and (5) lessons from completed work that contradicted an earlier plan.
- **Review gates** — Work cannot start until the story's *plan* is reviewed, and cannot close until its *work* is. Both gates run mechanical checks first — dependency cycles, whether the story is an epic, whether `verify` passes — and a finding marked BLOCKER cannot be approved past by anyone.
- **Independent review** — The reviews can be handed to a **different model**, so the agent doing the work is not the one grading it. Off by default; see [Reviewer](#reviewer). When one is configured the working agent's own verdict is refused outright, and a reviewer that cannot be reached records nothing rather than quietly handing the decision back.
- **Outcomes** — Closing a story records **why** (`completed`, `superseded`, `obsolete`, `wontfix`, `duplicate`) plus an optional note, so `done` / `cancelled` / `archived` no longer lose the reason. `mark_done` refuses to close a story without one.
- **Handoff notes** — Every closed story records what the next person needs to pick up from here. `mark_done` refuses without one. Relevant notes are injected into later turns, written into the story's commit message, and rolled up onto the epic when it closes — so the memory accumulates instead of dying with the conversation.
- **Learnings** — A story can record something that contradicted its own `proposed_changes` — a false assumption, a surprising API, a hidden dependency. Relevant ones are fed back into later turns. Most stories have none, and that is the expected case.
- **Linked continuation** — When a story is marked done, the next linked story is automatically promoted to `ready` and highlighted for the agent.
- **Dependency gating** — A story can’t be started or marked done if its dependencies aren’t finished.
- **TUI board** — `/stories` opens an interactive tree. Navigate with `↑↓`, press `R` ready, `S` start, `D` done, `X` cancel.
- **Export** — `/export-stories [path]` dumps all stories to human-readable Markdown (`stories.md` by default), nested by epic.

## Install

```bash
pi install npm:@ocramz/pi-issue-tracker
```

Needs **Node 24 or later** — the package ships TypeScript and relies on Node's native type stripping, so there is no build step and nothing to compile.

For local development, point pi at a checkout instead:

```bash
pi install /path/to/pi-issue-tracker      # user settings, ~/.pi/agent/settings.json
pi install -l /path/to/pi-issue-tracker   # project settings, .pi/settings.json
pi -e /path/to/pi-issue-tracker           # this run only, nothing written
```

Project-scoped packages (`-l`) load only once the project is trusted; a user-scoped install has no such gate.

## Commands

| Command | Description |
|--------|-------------|
| `/plan-stories <goal>` | Use the LLM to break down a goal into user stories under a root epic. Resolves `depends_on` and `next_id` chains, promotes the first unblocked story to `ready`, and reports what the planning calls cost. |
| `/stories` | Open an interactive story tree in the TUI (headless mode prints a plain list). |
| `/top-story <id>` | Set the top-level story that provides big-picture context on every turn. |
| `/export-stories [path]` | Write `stories.md` or the given path. |
| `/start-epic <id> [--worktree]` | Start an epic on `epic/<id>-<slug>`, branched from the current branch. With `--worktree`, in a checkout of its own — see below. |
| `/merge-epic [id]` | Bring the base branch into the epic, then fast-forward the base branch onto it. Always confirmed. |
| `/cancel-epic [id]` | Stop an epic without merging. The branch is kept, so this is reversible. |
| `/review-story <id> [work]` | Show the mechanical review findings for a story, and any verdict already recorded. Read-only. |
| `/undo-story <id>` | Reverse one story's commit — reset while it is still the tip, revert once it is not. |
| `/undo-merge [id]` | Put the base branch back exactly where it was before `/merge-epic`. |
| `/undo-turn` | Restore the working tree from the last turn's checkpoint. |

Planning tokens do not reach pi's built-in footer counter — that counter sums session entries, and a command's model calls never become session entries. `/plan-stories` totals them itself and shows them on the footer's extension-status line and in the completion notice.

## Git integration

Opt-in. Until `/start-epic` runs, nothing in git is touched and the tracker behaves exactly as it did before.

Once an epic is running, closing a story commits what it changed as one commit, titled after the story. Every destructive operation writes a `refs/pi/backup/<epic>/<operation>` ref first, so each command has an inverse. Each turn that ends with a dirty tree is checkpointed with `git stash create` under `refs/pi/checkpoint/<epic>/`, which is what `/undo-turn` restores; the newest twenty are kept.

### Branch mode vs worktree mode

| | Branch mode (default) | Worktree mode (`--worktree`) |
|---|---|---|
| Where work happens | The current checkout, switched to the epic branch | A separate checkout under the worktree root |
| Main checkout | Moves to the epic branch | Never touched |
| Concurrency | One at a time | Any number, each in its own pi session |
| A dirty tree at start | Offered to carry into the first commit | Irrelevant — the new checkout is elsewhere |

`/start-epic <id> --worktree` creates the worktree and **relocates the running pi session into it**. To run a second epic at the same time, open another pi session and start it there. All sessions share one `stories.db`, which is anchored to the main repository, so the story tree stays consistent across them. `/merge-epic` and `/cancel-epic` move the session back to the main repository before removing the worktree.

Worktrees are created outside the repository by default — a second full copy of the tree *inside* it makes every `rg`, `tsc --build` and test glob descend into it.

### `.pi/epic.json`

An optional manifest describing how to prepare and check an epic's environment. Every field is optional; a missing file means an empty manifest.

```json
{
  "setup": "npm ci",
  "verify": "npm test",
  "versions": "node --version && npm --version",
  "copy": [".env", "config/local.json"],
  "caches": ["npm_config_cache", "PIP_CACHE_DIR"]
}
```

- **`setup`** runs once per epic, and again only when the command string itself changes.
- **`verify`** must pass before a story is committed; a failure commits nothing.
- **`versions`** is captured at setup time so environment drift is detectable later.
- **`copy`** carries gitignored files into a new worktree. A worktree is a checkout, so it brings tracked files and nothing else. Paths are repo-relative; absolute paths and anything reaching outside the repository are refused.
- **`caches`** names environment variables pointed at one shared directory before `setup` runs, so several worktrees do not each download the world.

### `.pi/settings.json`

Every path the tracker uses is overridable under a `tracker` key, and by an environment variable that takes precedence over it.

| Key | Environment variable | Default |
|---|---|---|
| `repoRoot` | `PI_TRACKER_REPO_ROOT` | `git rev-parse --git-common-dir`, so a worktree resolves to the main checkout |
| `dbPath` | `PI_TRACKER_DB` | `<repo>/.pi/stories.db` |
| `worktreeRoot` | `PI_TRACKER_WORKTREE_ROOT` | `<parent of repo>/.pi-worktrees/<repo name>` |
| `manifestPath` | `PI_TRACKER_MANIFEST` | `<repo>/.pi/epic.json` |
| `reviewProvider` | `PI_TRACKER_REVIEW_PROVIDER` | unset — self-review |
| `reviewModel` | `PI_TRACKER_REVIEW_MODEL` | unset — self-review |

### Reviewer

Both review gates are self-reviewed by default: the working agent judges, and a
mechanical BLOCKER still cannot be approved past. Naming a second model hands the
judgement to something that did not write the code:

```json
{ "tracker": { "reviewProvider": "openrouter", "reviewModel": "anthropic/claude-sonnet-5" } }
```

Both halves are required; setting only one is reported at session start rather
than silently falling back, as are an unknown model and one with no credentials.
It costs two extra model calls per story, which is why it is opt-in — the
reviewer's token usage gets its own footer line, since a tool's model calls never
become session entries and pi's built-in counter cannot see them.

With a reviewer configured, three things change:

- The verdict is an **output**, not an input. A verdict passed by the working
  agent is refused — you do not grade your own work.
- A reviewer that errors or times out **records nothing** and leaves the gate
  shut. There is no fallback to self-certification; that would make the
  guarantee a lie precisely when it matters.
- The recorded verdict is attributed to the reviewer's model id instead of
  `self`, and shows that way on the board and in the export.

### Who may do what

The agent owns the **story** lifecycle end to end: it creates stories linked into
the graph, reviews them, starts them, does the work, reviews it, and closes them
with a handoff note. No human step is required in that loop.

The **epic** lifecycle is the user's: `/start-epic`, `/merge-epic`,
`/cancel-epic`. Merging rewrites the branch the user is standing on, and pi can
only relocate a session from a command handler, so both live in commands rather
than in the tool. An agent that needs one asks.

## Story Tool Actions (agent-usable)

- `create` — Add a new story with optional linking (`parent_story_id`, `next_story_id`, `depends_on`).
- `update` — Edit fields by ID. Pass `parent_story_id: null` to detach a story from its parent. Self-parenting and cycles are rejected.
- `delete` — Remove a story; its children are reparented rather than orphaned.
- `list` — Filter by status or show all.
- `search` — Find stories by title, sub-goal, or proposed changes.
- `review_plan` — Review a story before starting it. Call with only `story_id` to get the mechanical findings; call again with `verdict` and `findings` to record a judgement. Gates `mark_in_progress`.
- `review_work` — Review what a story produced before closing it: the pending diff and the manifest's `verify`. Same two-step shape. Gates `mark_done`.
- `mark_in_progress` — Move to `in_progress` (blocked by unmet dependencies, by being an epic, and by an unapproved plan review).
- `mark_done` — Close a story and auto-promote `next_id` to `ready`. **Requires `resolution` and `handoff_notes`**, and an approved work review; accepts `resolution_note` and `learnings`.
- `get_next` — Return the top `ready` leaf story with no unmet dependencies.
- `set_top_level` — Designate a story as the big-picture context.
- `reorder` — Rewrite priorities and `next_id` chain for a given ID order.
- `simplify` — Merge multiple stories into a single one, archiving the sources as `superseded`, adopting their children, and repointing anything that depended on them.

### Trying concurrent epics by hand

Two epics at once means two pi sessions. The library-level guarantees are covered by
`test/worktree.test.ts`; this is what it looks like from the outside.

```bash
git switch -c feat/scratch          # main and master are refused as bases
# /plan-stories a goal that splits into two independent epics, then:

# Session one
/start-epic <a> --worktree          # the session relocates into the worktree

# Session two, started separately in the main checkout
/start-epic <b> --worktree          # accepted; branch mode would refuse here

# Close a story in each — one commit lands on each epic branch, in each worktree,
# and both sessions see the same story tree. Then, in each session:
/merge-epic                         # returns to the main repo, then removes the worktree
```

## Architecture

- **`src/` must not import from `@earendil-works/*`.** [extensions/index.ts](pi-issue-tracker/extensions/index.ts)
  is the only pi-aware file: it builds a `TrackerContext` (paths, db, injected git/shell runners,
  clock, notify) and delegates. That boundary is what lets everything below run under plain
  `node --test` against a temp repository, with no pi runtime and no network.
- **Git runners never throw.** `pi.exec` resolves with a non-zero `code` on failure, and both
  `GitRunner` implementations match that contract deliberately — `code !== 0` is the only error
  signal.
- **There is no "the" active epic.** Worktree mode allows any number of concurrent epics across pi
  sessions sharing one `stories.db`. `resolveSessionEpic` answers "which epic is *this* session on"
  by path, not by branch (the user is allowed to wander off the epic branch mid-epic). Cache the
  **id**, re-read the row on every use.
- **`transitionStatus` is the single write path for `status`**, and git effects hang off it. The two
  deliberate bypasses (`simplify`, `/plan-stories`) write status inside a SQLite transaction, which
  cannot stay open across a git subprocess. Any new status writer goes through `transitionStatus`.
- **Nothing becomes unreachable.** Every destructive operation writes `refs/pi/backup/<epic>/<op>`
  first, so each command has an inverse. Nothing is pruned unasked except turn checkpoints (newest
  twenty kept).
- **Merging is two steps in order**: `merge --no-ff <base>` *into* the epic branch (so conflicts
  surface where the agent works), then fast-forward the base onto the epic. The other direction is
  wrong and is not done.
- **No schema migrations.** `INIT_SQL` is all `CREATE TABLE IF NOT EXISTS`; adding a column means
  deleting `.pi/stories.db`. `PRAGMA user_version` is unused.


## Constraints discovered in the SDK

- Session relocation only works from a *command*
handler
- `withSession` callbacks run in a torn-down closure where only plain strings survive
- `ui.notify` is lost across a session switch
- a session with no assistant message has no file to fork. 

Be extra careful if touching `relocateSession` or anything around `switchSession`.