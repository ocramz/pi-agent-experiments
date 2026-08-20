# Pi Issue Tracker Extension

An extension for **pi** that turns a high-level goal into a linked, tracked set of user stories stored in a project-local SQLite database.

## Features

- **Plan from a goal** — `/plan <goal>` breaks down work into user stories using the active model.
- **Story tool** — The agent can create, update, delete, list, search, simplify, reorder, and mark stories done.
- **Context injection** — Before every turn, the extension injects an auto-updated story board into the conversation so the agent always knows what’s open, in-progress, and next.
- **Linked continuation** — When a story is marked done, the next linked story is automatically promoted to `ready` and highlighted for the agent.
- **Dependency gating** — A story can’t be started or marked done if its dependencies aren’t finished.
- **TUI board** — `/stories` opens an interactive kanban-like list. Navigate with `↑↓`, press `R` ready, `S` start, `D` done, `X` cancel.
- **Export** — `/export-stories [path]` dumps all stories to human-readable Markdown (`stories.md` by default).

## Files

```
.pi/extensions/issue-tracker/
  index.ts      → Extension factory (tools, commands, lifecycle, context)
  database.ts   → SQLite schema and CRUD helpers
  types.ts      → Shared TypeScript interfaces
  README.md     → This file
```

## Commands

| Command | Description |
|--------|-------------|
| `/plan <goal>` | Use the LLM to break down a goal into user stories. Automatically resolves `depends_on` and `next_id` chains. |
| `/stories` | Open an interactive story board in the TUI (headless mode prints a plain list). |
| `/export-stories [path]` | Write `stories.md` or the given path. |

## Story Tool Actions (agent-usable)

- `create` — Add a new story with optional linking.
- `update` — Edit fields by ID.
- `delete` — Remove a story.
- `list` — Filter by status or show all.
- `search` — Find stories by title, sub-goal, or proposed changes.
- `mark_in_progress` — Move to `in_progress` (blocked by unmet dependencies).
- `mark_done` — Close a story and auto-promote `next_id` to `ready`.
- `get_next` — Return the top `ready` story with no unmet dependencies.
- `reorder` — Rewrite priorities and `next_id` chain for a given ID order.
- `simplify` — Merge multiple stories into a single one and archive the sources.
