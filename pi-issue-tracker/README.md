# Pi Issue Tracker

An extension for **pi** that turns a high-level goal into a linked, tracked set of user stories stored in a project-local SQLite database.

## Features

- **Plan from a goal** — `/plan-stories <goal>` breaks down work into user stories using the active model. The goal itself becomes a root **epic**, every generated story is parented to it, and it is set as the big-picture story automatically.
- **Story tool** — The agent can create, update, delete, list, search, simplify, reorder, and mark stories done.
- **Hierarchy** — Stories form a tree. A story with children is an epic: it is never handed out as work, and it closes automatically once its last child closes. The board, the markdown export, and the injected context all show the tree.
- **Context injection** — Before every turn, the extension injects a focused story context showing: (1) the next ready story to work on and the epic it belongs to, (2) the top-level big-picture story, (3) the story just completed in the previous turn, (4) other in-progress stories, and (5) lessons from completed work that contradicted an earlier plan.
- **Outcomes** — Closing a story records **why** (`completed`, `superseded`, `obsolete`, `wontfix`, `duplicate`) plus an optional note, so `done` / `cancelled` / `archived` no longer lose the reason. `mark_done` refuses to close a story without one.
- **Learnings** — A story can record something that contradicted its own `proposed_changes` — a false assumption, a surprising API, a hidden dependency. Relevant ones are fed back into later turns. Most stories have none, and that is the expected case.
- **Linked continuation** — When a story is marked done, the next linked story is automatically promoted to `ready` and highlighted for the agent.
- **Dependency gating** — A story can’t be started or marked done if its dependencies aren’t finished.
- **TUI board** — `/stories` opens an interactive tree. Navigate with `↑↓`, press `R` ready, `S` start, `D` done, `X` cancel.
- **Export** — `/export-stories [path]` dumps all stories to human-readable Markdown (`stories.md` by default), nested by epic.

## Install

```bash
pi install npm:pi-issue-tracker
```

Or via git:

```bash
pi install git:github.com/<user>/pi-issue-tracker@v1.0.0
```

## Commands

| Command | Description |
|--------|-------------|
| `/plan-stories <goal>` | Use the LLM to break down a goal into user stories under a root epic. Resolves `depends_on` and `next_id` chains, promotes the first unblocked story to `ready`, and reports what the planning calls cost. |
| `/stories` | Open an interactive story tree in the TUI (headless mode prints a plain list). |
| `/top-story <id>` | Set the top-level story that provides big-picture context on every turn. |
| `/export-stories [path]` | Write `stories.md` or the given path. |

Planning tokens do not reach pi's built-in footer counter — that counter sums session entries, and a command's model calls never become session entries. `/plan-stories` totals them itself and shows them on the footer's extension-status line and in the completion notice.

## Story Tool Actions (agent-usable)

- `create` — Add a new story with optional linking (`parent_story_id`, `next_story_id`, `depends_on`).
- `update` — Edit fields by ID. Pass `parent_story_id: null` to detach a story from its parent. Self-parenting and cycles are rejected.
- `delete` — Remove a story; its children are reparented rather than orphaned.
- `list` — Filter by status or show all.
- `search` — Find stories by title, sub-goal, or proposed changes.
- `mark_in_progress` — Move to `in_progress` (blocked by unmet dependencies, and by being an epic).
- `mark_done` — Close a story and auto-promote `next_id` to `ready`. **Requires `resolution`**; accepts `resolution_note` and `learnings`.
- `get_next` — Return the top `ready` leaf story with no unmet dependencies.
- `set_top_level` — Designate a story as the big-picture context.
- `reorder` — Rewrite priorities and `next_id` chain for a given ID order.
- `simplify` — Merge multiple stories into a single one, archiving the sources as `superseded`, adopting their children, and repointing anything that depended on them.

## Schema notes

The database lives at `<project>/.pi/stories.db`. There is **no migration system** — schema changes mean deleting that file. Add one (`PRAGMA user_version` plus an ordered list of `ALTER TABLE` steps) before the data starts mattering.
