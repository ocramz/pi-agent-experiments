# The interactive tier

38 cases covering the ten slash commands and the story board — everything the other automated
suites structurally cannot reach.

## Why it needs a pty

`make check`'s other tiers cover `extensions/index.ts`'s hooks and its `story` tool by driving a
real model. They cannot reach the commands. Slash commands are dispatched by pi's TUI alone:
print mode never parses them, RPC mode can `get_commands` but has no case to execute one, and
`/plan-stories` refuses outright unless `ctx.mode` is `"tui"`. The board is a TUI component
driven by keystrokes.

`cli-testing-library` spawns with `child_process.spawn` and pipes — it allocates no pty. pi
resolves its mode with `parsed.print || !stdinIsTTY || !stdoutIsTTY → "print"`, so driving it
through the library alone lands in exactly the mode that cannot run a command. `script(1)` sits
between the two: it allocates a pty, runs pi inside it, and copies the master end to and from
the pipes the library holds. pi sees a terminal; the library sees a stream.

The rest follows from that. See the header of
[shared/test/tui/pi-session.ts](../../../shared/test/tui/pi-session.ts) for why `COLUMNS` is
load-bearing and why assertions go through `screen()` rather than the library's `findByText`.

## Where the harness lives

The pty machinery is shared by every extension in the repo and sits in
[shared/test/tui/pi-session.ts](../../../shared/test/tui/pi-session.ts). It knows how to get pi
running under a pty and how to read its screen; it knows nothing about this extension.

[session.ts](session.ts) is this package's binding to it — a ~25-line wrapper that builds a
fixture, calls `startPi`, and mixes in [inspect.ts](inspect.ts). That is what a case imports, and
why `session(t, "stories")` still returns one object carrying `facts`, `db()` and `expect()`
together.

The wrapper also owns the fixture directory, and hands `startPi` an `afterExit` callback to
delete it. That is deliberate rather than a second `t.after`: deleting the tree while pi still
held the database open is a race, and hook-unwind order is not something to infer.

## Running it

Needs pi on `PATH`, so it runs in the dev container:

```bash
make test-tui                    # from the repo root, one shot
# or, inside `make shell`:
cd /workspace/pi-issue-tracker
npm run test:tui                 # all 38
node --test test/tui/start-epic.test.ts    # one group
```

`npm run test:tui` installs the shared `shared/test/tui/node_modules` first, and loads
`PI_PROVIDER`/`PI_MODEL` from `shared/versions.env` on the way through
`shared/with-versions.sh` — a live case asserts on their presence rather than falling back to a
literal. Running `node --test` directly, as the one-group form above does, means exporting them
yourself if the group contains a live case.

That dependency scope is deliberately not in any package: a package's
`node_modules/@earendil-works/*` are symlinks into the container's global pi install, and an
`npm install` at a package root would reify that tree and prune them. It sits next to
`pi-session.ts`, the only file that imports from it, because node resolves those imports by
walking up from the importing file. `npm run typecheck` installs it too — this package's
`tsconfig.json` type-checks the shared harness along with these files, so the compiler needs the
same scope node does.

Four cases — B1, B3, I1 and W10 — drive a real model and need `OPENROUTER_API_KEY`, which
`make test-tui` passes from `.env`. Without it [live.test.ts](live.test.ts) fails the run rather
than skipping quietly; `PI_TUI_SKIP_LIVE=1` is the explicit opt-out, used by the fork CI job.

## The groups

| File | Cases | Covers |
|---|---|---|
| [board.test.ts](board.test.ts) | A1–A8 | `/stories`: rendering, arrows, `r` `s` `d` `x`, `escape`, review markers and handoff notes. A5 is the important one — closing a story inside an active epic is the only route from a keystroke to a git commit. A8 pins the board's deliberate bypass of the review gates |
| [commands.test.ts](commands.test.ts) | B2, C1–C6 | `/plan-stories` usage, `/top-story`, `/export-stories` |
| [review-story.test.ts](review-story.test.ts) | J1–J8 | `/review-story`: the mechanical half of both review gates. The gates themselves are tool actions and unreachable from the TUI, so this covers the shared `reviewPlan`/`reviewWork` path — deterministically, with no model |
| [start-epic.test.ts](start-epic.test.ts) | D1–D9 | One case per refusal in `checkCanStartEpic`, plus the dirty-tree prompt both ways and flag parsing |
| [merge-epic.test.ts](merge-epic.test.ts) | E1–E5, F1–F2 | `/merge-epic` confirm, decline, base-moved, conflict, already-merged; `/cancel-epic` |
| [undo.test.ts](undo.test.ts) | G1–G4, H1–H2, I2–I3 | `/undo-story` reset and revert paths, `/undo-merge`, `/undo-turn` |
| [worktree.test.ts](worktree.test.ts) | W1–W8 | `/start-epic --worktree`, concurrent epics, worktree-aware merge and cancel, session scoping |
| [live.test.ts](live.test.ts) | B1, B3, I1, W10 | The four that need a model turn. Costs a little money |

## How a case is built

Every case is the same four moves: build a fixture, drive pi, close it, assert on state.

```ts
it("D1 creates the branch, backup ref and in_progress status", async (t) => {
  const s = await session(t, "stories");        // fixture + pi, cleaned up on exit
  await s.command(`/start-epic ${s.facts.epicId}`);
  await s.expect("epic #1 started on epic/1-ship-the-widget");
  await s.close();                              // assert only after pi has gone
  assert.equal(s.db((db) => getEpicBranch(db, 1)?.state), "active");
});
```

Both halves matter, and for refusals they matter in different ways: `expect` proves the message
was shown, and the state assertions prove no side effect fired. The manual suite this replaced
could only machine-check the second half — it asked the operator `Did you see: "…"? [y/N]` for
the first, sixteen times.

Assert **after** `close()`. pi holds the database in WAL mode and serialises its git effects
through a promise chain; reading either while the session is still alive races it.

## Adding a case

1. Pick the file for its command group, or start a new one.
2. If it needs a repository state that does not exist yet, add a shape to
   [fixtures.ts](fixtures.ts). Build fixtures by calling `src/` — `startEpic`, `commitStory`,
   `mergeIntoBase` — rather than by scripting git, so a fixture cannot drift from the code path
   it is setting up.
3. Read state through [inspect.ts](inspect.ts) and the package's own accessors, not raw SQL.

## Debugging a red case

```bash
PI_TUI_KEEP=1 node --test test/tui/merge-epic.test.ts   # keeps the fixture, prints its path
```

A failed `expect` already prints the last 2000 characters of what pi actually rendered. With the
fixture kept, the rest is ordinary forensics:

```bash
cd /tmp/pi-tui-XXXX/fx
git log --oneline --all --decorate
git for-each-ref refs/pi
node --input-type=module -e 'import {DatabaseSync} from "node:sqlite";
  const d = new DatabaseSync(".pi/stories.db");
  console.log(d.prepare("select * from epic_branches").all());'
```

## Deliberate omissions

**`/undo-merge` with no argument, against more than one merged epic.** The ordering it depends on
is now correct — timestamps are written from `ctx.now` at millisecond resolution and selection is
by `updated_at`, so "the last epic to merge" is a real answer rather than a coin toss between rows
sharing a second. But asserting it needs a controlled clock, which makes it a unit test, not an
interactive one. It lives in [../database.test.ts](../database.test.ts) as "picks the last merged
epic by when it merged, not by when it started".

**A second command after a session switch.** W10 relocates a session into a worktree and proves it
with the session file pi wrote there. It stops at that point on purpose: typing another command into
the rebuilt TUI does not work here. `switchSession` tears the TUI down and rebuilds it around the
replacement session, and keystrokes sent afterwards arrive as one or two stray characters — the
command is never parsed. Waiting does not fix it: pi prints its `ctrl+o more` hint only on the first
paint, so there is nothing to poll for, and a fixed sleep did not help either. That looks like the
pty surviving the rebuild while the library's pipe into it does not.

Two consequences. Worktree-mode `/merge-epic` and `/cancel-epic` are covered from the *outside* — W5
and W7 drive them from a session in the main checkout, which is a real usage and needs no switch —
and from below, in [../worktree.test.ts](../worktree.test.ts), which exercises `mergeIntoBase`,
`releaseWorktree` and `cancelEpic` against real worktrees. What is not machine-checked anywhere is
the keystroke path "type /merge-epic into a session that has already been relocated". The manual
check in the package README covers it.

**A second concurrent session.** W3 proves the *rule* — a second epic that branch mode refuses is
accepted with `--worktree` — but it does so from one pi session. Two sessions running at the same
time against one repository, which is how concurrency is actually used, is covered by
[../worktree.test.ts](../worktree.test.ts) at the library level and by the manual check in the
package README. Driving two ptys at once from one case is possible and has not been worth it.
