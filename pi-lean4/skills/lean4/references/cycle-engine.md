# Cycle Engine Reference

These workflows share a six-phase cycle. **prove** is guided (the user approves plans and commits); **autoprove** is autonomous. Everything runs in one thread.

Budgets for unattended runs are enforced by `/lean autoprove`, which measures sorries and errors after every turn.

## Six-Phase Cycle

```
Plan → Work → Checkpoint → Review → Replan → Continue/Stop
```

1. **Plan** — Discover state via LSP (`lean_verify {op: "sorries"}`, `lean_goal`), identify sorries, set order
2. **Work** — Fill sorries using search + tactics (see [sorry-filling.md](sorry-filling.md))
3. **Checkpoint** — Stage and commit progress
4. **Review** — Quality check at configured intervals
5. **Replan** — Produce/update the action plan
6. **Continue/Stop** — prove: ask the user; autoprove: continue or stop

## LSP-First Protocol

LSP tools are the normative first pass for all discovery, search, and validation. Fall back to `rg` over `.lake/packages/mathlib` only when the LSP is unavailable or its searches came back empty.

**Planning phase (per target sorry):**
1. `lean_goal {path, line}` — understand the goal before ordering
2. Up to 3 searches (time-boxed ~30s total): `lean_search {source: "local"}`, preferably `lean_search {source: "leanfinder"}` with the goal text for semantic search (`source: "leansearch"` for natural language, `source: "premises"` for premise suggestions), and `lean_search {source: "loogle"}` for type-pattern gaps
3. Record top candidate lemmas and intended next attempts in the plan
4. **Trivial-goal shortcut:** if the goal is obviously solvable (`rfl`, `simp`, `exact` with a known lemma), skip extended search and go straight to work

**Work phase (per sorry):**
1. Refresh `lean_goal {path, line}`
2. Up to 2 more searches (skip if the goal is trivial or the planning search was conclusive)
3. Generate 2-3 candidate snippets from the results. When premise search returns premises, try `simp only [p1, p2]` and `grind [p1, p2]`.
4. Test with `lean_attempt {op: "tactics", path, line, snippets: [...]}`
5. `lean_diagnostics {path}` — verify; if "Try this" → `lean_nav {op: "code_actions", path, line}` → apply → `lean_diagnostics {path}` again
6. Prefer the shortest passing candidate; only then edit/commit

**Fallback gate:** grep-based search and [compiler-guided repair](compiler-guided-repair.md) are permitted when at least 2 searches came back empty/inconclusive, or the LSP is unavailable or timing out. For sorry discovery, `lean_verify {op: "sorries", path}` is the one-pass inventory.

**Validation:** `lean_diagnostics {path}` per edit. Reserve `lean_build` for checkpoints and the final gate. See [Build Target Policy](#build-target-policy) for the full ladder.

## Build Target Policy

For fresh clones/worktrees or after `lake clean`, hydrate the cache first (`lean_build {fetchCache: true}`) and build once only if needed to bootstrap the LSP; the ladder below is the steady-state workflow.

Three-tier verification ladder — use the lightest tool that answers the question:

| Tier | Tool | When | Speed |
|------|------|------|-------|
| Per-edit | `lean_diagnostics {path}` | After every edit | Sub-second |
| File compile | `lake env lean <path/to/File.lean>` | File-level gate, import checks | Seconds |
| Project gate | `lean_build` | Checkpoint, final gate, `/lean-checkpoint` | Minutes |

Run `lake env lean` from the Lean project root; pass repo-relative file paths.

**Target spellings.** `lake lean <path/to/File.lean>` (from the project root) builds the file's imports and then runs Lean on that exact file; it accepts any `.lean` file in the workspace, module or not. `lake build <path/to/File.lean>` (a source path under a `lean_lib` `srcDir`) builds that one module and its changed dependencies; older Lake releases did not accept source paths. `lake build +Pkg.Module` does the same by module name — **never derive a module name by textually turning `/` into `.`** (`src/Foo/Bar.lean` is `Foo.Bar`, not `src.Foo.Bar`). `lake build` rejects a path that does not resolve to a workspace module (a scratch file outside every `lean_lib`, the bare basename of a nested file, a path without `.lean`); `lake lean` accepts those files.

### File Gate Scope

`lake env lean File.lean` (run from the project root) elaborates that source file against the currently built import environment; it does not rebuild imported modules. If an imported source differs from its `.olean`, the file gate can produce either a **false pass** (the import's old `.olean` still satisfies the file) or a **false failure** (the import was fixed in source but its `.olean` is stale). This is Lake behaving as designed, not a defect — the file gate is a fast file-local check, valid while the imports it reads are up to date.

After editing any imported module, take one of two recovery paths before trusting the file gate:

1. Rebuild every changed imported module (`lake build <path/to/ChangedImport.lean>`, or `lean_build`), then rerun the file gate on the importing file.
2. Run `lake lean <path/to/File.lean>` for the importing target directly. `lake lean` builds the file's imports and then runs Lean on that exact file: it is dependency-aware, it works for any `.lean` file in the workspace (including a scratch file outside every `lean_lib`), and it does not write the target's own `.olean`. `lake build <path/to/File.lean>` is the optional actual module build — use it when the path is a recognized workspace module and the installed Lake accepts source-path targets; it also writes the target's artifacts, so a later source rollback without a rebuild leaves them stale.

Neither replaces the project gate: final verification may still require the appropriate project or checkpoint target (`lean_build`, `/lean-checkpoint`). Workflows that edit across files — refactoring, axiom elimination — are exactly where an import goes stale mid-session, so they should prefer path 2 at each file gate that follows a cross-file edit.

The resulting hierarchy, lightest first (all run from the project root):

```
lake env lean path/to/File.lean   # fast pre-screen; uses already-built imports only
lake lean     path/to/File.lean   # dependency-aware file gate: builds imports, then elaborates this exact file
lake build    path/to/File.lean   # optional module build (recognized workspace module; writes its artifacts)
lake build                        # project / checkpoint / final integration gate (lean_build)
```

**`lake build` progress counter:** Lake's `[N/M]` denominator grows as dependencies are discovered mid-build (e.g., 129 → 7808 in one observed run). It is not a reliable progress estimate; set timeouts from wall-clock experience with the current project.

## Review Phase

At configured intervals, run a review matching the current scope (see the [lean4-review skill](../../lean4-review/SKILL.md)):
- Working on a single sorry → review that declaration
- Working on a file → review the file
- Never trigger a project-wide review automatically

Reviews act as gates: review → replan → continue. In prove, replan requires user approval; in autoprove, replan auto-continues.

## Replan Phase

After review, produce or update the action plan (3-6 steps); the next Work phase follows it. Carry forward failed approaches and blockers so they are not retried without new evidence.

## Stuck Definition

A sorry or repair target is **stuck** when any of these hold:

1. Same sorry failed 2-3 times with no new approach
2. Same build error repeats after 2 repair attempts
3. No sorry count decrease for 10+ minutes
4. LSP search returns empty twice for the same goal

**Same blocker** is computed as `(file, line, primary_error_code_or_text_hash)`. Two consecutive iterations producing the same blocker signature = same blocker.

**When stuck is detected** (procedure: [stuck triage](../../lean4-prove/SKILL.md#stuck-triage)):

| Step | prove | autoprove |
|------|-------|-----------|
| 1. Review | Stuck review of the blocked declaration | Same |
| 2. Replan | Summarize findings, fresh plan (3-6 steps) | Revised plan |
| 3. Approval | Present for user approval: `[yes / no / skip]` | Auto-approve; next cycle executes the plan |
| 4. On decline | Offer counterexample/salvage pass | N/A (autonomous) |

**Stuck evidence:** when declaring a sorry stuck, report the searches attempted (source + query), the top candidate lemmas, and the `lean_attempt` outcomes (snippets tested, pass/fail each).

**Important:** a stuck-triggered replan is mandatory even when planning is otherwise off. It is a safety mechanism.

**Counterexample / salvage:** when the user declines the plan (prove) or the review flags falsification (autoprove): search for an explicit witness (small domain, concrete instantiation); if found, create `T_counterexample` and a provable `T_salvaged` (see [Falsification Artifacts](#falsification-artifacts)); `/lean-disprove` is the dedicated pipeline.

## Deep Mode

The **escalation pass** for a stubborn sorry, run in the main thread once the fast path is stuck. It trades breadth for depth: a written plan, helper lemmas, more attempts on one target.

1. **Plan first.** Before any edit, write a 3-6 step plan naming the helper lemmas you intend and the key library facts.
2. **Snapshot = the original text you read.** `read` the target declaration (and every region you will touch) and keep that text verbatim; it is the rollback point.
3. **Helper lemmas only in the target file**, placed directly above the declaration that uses them. No edits to other files; if the proof needs cross-file work, stop and report it.
4. **Header fence** — the statement is immutable (below).
5. **Regression gate.** Before the first edit, record `lean_diagnostics {path}` and the sorry count (`lean_verify {op: "sorries", path}`); re-check after each step.
6. **Revert with `edit` on regression** — restore the snapshot text exactly — and mark the sorry stuck with a reason, e.g. `"escalation: regression — sorry count 3 → 5"`.

**Regression:** sorry count increases, new error diagnostics appear, or a new blocker signature appears compared to the snapshot. **No improvement:** sorry count unchanged and no diagnostic improvement — the target is stuck.

**Budget:** one sorry per pass in prove (at most two in autoprove), roughly 120 changed lines (200 in autoprove), one pass per cycle. Budget exhausted with no progress → stuck. Statement changes are never permitted: revert, mark stuck, and hand off to `/lean-formalize` (prove) or emit `next_action = redraft` when the synthesis outer loop is active (autoprove).

### Header Fence

Declaration headers (everything from `theorem`/`def`/`lemma` through `:= by`) are immutable during proof work. Compare each header against the snapshot at every checkpoint.

| Context | On header change |
|---------|-----------------|
| prove (escalation) | Revert immediately, mark stuck: `"header fence — declaration header modified"`. Suggest `/lean-formalize`. |
| autoprove (escalation) | Revert immediately, mark stuck. When the synthesis outer loop is active, emit `next_action = redraft`. |
| `/lean-formalize` | Statement changes are owned by the synthesis wrapper, not the proof engine; it redrafts when needed. |

## Checkpoint Logic

If commits are disabled for the run, skip the checkpoint commit — changes stay in the working tree. Otherwise, when there is a non-empty diff (procedure: [lean4-review skill § Checkpoint](../../lean4-review/SKILL.md#checkpoint)):
- **prove:** stage only files from **accepted** fills (exclude declined fills)
- **autoprove:** stage only files from successful, non-reverted work
- **Both:** never stage a file whose escalation pass was reverted
- Stage by name (`git add <files>`), then `git commit -m "checkpoint(lean4): [summary]"`

If no files changed this cycle, say "No changes this cycle — skipping checkpoint". Never create an empty commit.

## Falsification Artifacts

```lean
/-- Counterexample to the naive statement `T`. -/   -- preferred
theorem T_counterexample : ∃ w : α, ¬ P w := by
  refine ⟨w0, ?_⟩
  -- proof

/-- Salvage: a weaker version of `T` that is true. -/
theorem T_salvaged (extra_assumptions...) : Q := by
  -- proof
```

**Safety:** Avoid proving `¬ P` if a `theorem T : P := by sorry` exists — unless the user explicitly chose a negation policy. For the dedicated counterexample-search pipeline use `/lean-disprove` (upstream design: [disprove-engine.md](https://github.com/cameronfreer/lean4-skills/blob/b6243b85b9b0a0ddff5bb6773889044daf687f8e/plugins/lean4/skills/lean4/references/disprove-engine.md)).

## Repair Mode

Compiler-guided repair is an **escalation-only** workflow — not the default response to a first failure. Use it only when compiler errors are the active blocker and LSP-first tactics cannot resolve them. The loop itself is in [compiler-guided-repair.md](compiler-guided-repair.md).

**Trigger conditions** (any one sufficient):
- Same blocker signature repeats 2 consecutive iterations
- Same build error repeats after 2 repair attempts
- 3 or more distinct compiler errors active in scope simultaneously

**Direct-fix-first rule:** for straightforward single errors (missing import, obvious coercion, local instance, simple typo), apply the fix directly. Enter the repair loop only if the direct fix fails or the error recurs.

| Budget | prove | autoprove |
|-----------|-------|-----------|
| Max repair attempts per error signature per cycle | 2 | 2 |
| Max total repair attempts per cycle | 6 | 8 |

**Improvement:** error count in scope decreases OR the current blocker signature disappears. A repair that changes errors without reducing the count is neutral (it counts toward the budget). **No improvement** on the same signature for 2 consecutive attempts → **stuck**; force review + replan ([Stuck Definition](#stuck-definition)). In prove, ask the user for guidance; in autoprove, pick the next strategy automatically.

For error-by-error fixes see [compilation-errors.md](compilation-errors.md); for persistent issues, [capture a build log](compilation-errors.md#build-log-capture).

## Safety

Blocked git commands (both prove and autoprove): `git push` and `gh pr create` (review first), `git commit --amend` (preserve history), `git checkout --`/`git restore`/`git reset --hard`/`git clean` (commit or checkpoint first; revert your own edits with `edit` instead).

## Synthesis Outer Loop

Optional wrapper around the inner cycle, used by `/lean-formalize`: acquire a statement, prove it, and route on the stuck review.

```
for each claim, in source order:
  1. Statement acquisition: draft the declaration → validate (lean_diagnostics)
     → commit "draft: <summary>" unless commits are off; record it as session-generated
  2. Inner cycle: the standard six-phase cycle, unchanged
  3. If the inner cycle stopped stuck: route on the stuck review's next_action
     else: advance to the next claim
```

| `next_action` | Response |
|---------------|----------|
| `continue` | Resume the inner cycle with the revised plan |
| `deep` | Run the escalation pass ([Deep Mode](#deep-mode)) |
| `repair` | Enter [Repair Mode](#repair-mode) for compiler blockers |
| `redraft` | Re-draft the stuck declaration (subject to statement safety) |
| `golf` | Golf the now sorry-free file (`/lean-golf`) |
| `stop` | Halt this claim; advance to the next (or stop if none remain) |

**Statement safety:** user-authored statements are never rewritten. A statement drafted in this session may be redrafted; otherwise add a `T_salvaged` sibling. Provenance is in-memory for one session — after a restart every existing statement counts as user-authored.

**File assembly:** append declarations with fully-qualified names, deduplicate new imports at the top of the file, and skip a declaration whose name already exists in the target (formalized in a prior run).
