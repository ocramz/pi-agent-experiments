# Pi Issue Tracker — internals

Implementation notes for the extension. User-facing docs are in the [top-level README](../README.md).

## Files

```
pi-issue-tracker/
  extensions/index.ts  → Extension factory (tool, commands, lifecycle, context injection, TUI)
  src/database.ts      → SQLite schema and CRUD helpers
  src/related.ts       → Pluggable relevance strategy (related stories, learnings)
  src/types.ts         → Shared TypeScript interfaces
  src/README.md        → This file
```

## Data model

One table, `stories`, plus `app_state` (key/value) and `story_history` (append-only audit log).

Structure is carried by three independent fields:

- `parent_id` — the tree. A story with children is an **epic**: excluded from `get_next` and from ready-selection, and closed automatically by `rollUpEpics` when its last child closes. `/plan-stories` materialises the goal itself as the root epic, which is what makes `parent_id` non-null in practice.
- `depends_on` — a DAG, stored as a JSON array (so it is not queryable in SQL). Gates `mark_in_progress` and `mark_done`.
- `next_id` — a linear suggestion chain. Closing a story promotes its `next_id` to `ready`.

Outcome fields are set when a story closes: `resolution` (enum, validated in TypeBox rather than by a SQL `CHECK` so the vocabulary can still change), `resolution_note`, and `learnings`.

## Things worth knowing

- **No migrations.** `INIT_SQL` is all `CREATE TABLE IF NOT EXISTS`, so it is a no-op against an existing database. Adding a column means deleting `.pi/stories.db`. `PRAGMA user_version` is unused and sits at 0.
- **No foreign keys.** Referential integrity is enforced in TypeScript: `wouldCreateCycle` on reparenting, child reparenting on delete, dependency repointing on `simplify`.
- **`getDb` caches a module-level singleton** keyed on nothing — the first `dbPath` wins for the process, so a session switch to another project keeps the first database.
- **`updateStory` builds its SET clause by interpolating object keys.** Safe today because every call site passes an object literal with `Story` keys, but it is a `${}` into SQL — do not spread untrusted tool params into it.
- **`story_history` is write-only.** Every create/update/delete logs a row and `getHistory` can read them, but nothing surfaces it yet.
- **Relevance is pluggable.** `RelatedStoriesStrategy` has two methods — `findRelated` (open stories) and `findLearnings` (closed stories carrying a learning). `keywordStrategy` scores word overlap plus structural boosts; swapping in embeddings means implementing the same interface.

## Token accounting

`/plan-stories` is a *command*, not a tool. pi's footer counter sums `sessionManager.getEntries()` over assistant messages, tool results carrying `usage`, and compaction entries — a command's `modelRegistry.complete()` call appends none of those, and `ExtensionCommandContext` offers no way to report usage. So planning totals its own `response.usage` and renders it via `ui.setStatus`, which lands on the footer's extension-status line.

A live per-token counter is not reachable from an extension: `ModelRegistry` exposes only `complete()` (internally `stream(...).result()`, which discards the per-event `partial.usage`), and `BorderedLoader`'s label is fixed at construction. Both would need SDK changes.
