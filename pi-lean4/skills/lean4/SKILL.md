---
name: lean4
description: "Lean 4 and Mathlib essentials for this workspace: how to use the lean_* tools (goals, diagnostics, tactic testing, lemma search, axiom and sorry checks, builds), the search decision tree, the verification ladder, tactic cascades, type-class patterns, Mathlib style, and Lean/Lake/cache troubleshooting. Use for any Lean 4 task not covered by a more specific lean4-* skill: questions about Lean or Mathlib, finding a lemma, explaining an error, small edits to .lean files, or setting up a Lake project. Not for Coq/Rocq, Agda, Isabelle, HOL or other provers."
license: "MIT (see THIRD_PARTY_NOTICES.md in the pi-lean4 package)"
compatibility: "Requires the pi-lean4 extension (lean_* tools) and a Lean 4 Lake project."
---

# Lean 4 theorem proving

Lean's type checker is the test suite: a proof that compiles with no `sorry` and only standard
axioms is correct. Everything below is about getting there with as little guessing as possible.

<!-- ground-rules:start -->
## Ground rules

- **Search before you prove.** Mathlib or Lean core probably has it: `lean_search` before tactics.
- **Every edit is checked.** `edit`/`write` on a `.lean` file may come back with a
  `[lean auto-check]` line (errors and sorries after the edit); without one, use `lean_diagnostics`.
- **Statements are the contract.** Never change a theorem statement or a declaration header
  (`theorem`/`lemma`/`def` through `:=`) unless the user asks. Never add an `axiom`. Never use
  `sorry` to silence an error.
- **Look, don't guess.** `lean_goal` before each step; `lean_attempt {op: "tactics"}` to try 2–4
  candidates before editing.
- **Style.** 100-character lines; `fun x ↦ …` for ordinary lambdas; existing docstrings are API.
- **Scratch work** goes through `lean_attempt {op: "code"}`, never into new files in the project.
- **Git.** Stage only the files you touched (`git add <files>`, never `-A`). Destructive git is
  blocked in Lean projects: undo your own changes with `edit`.
- **Done means** no errors, no sorry in scope, and `lean_verify {op: "axioms"}` showing only
  `propext`, `Classical.choice`, `Quot.sound`.
<!-- ground-rules:end -->

## Which skill

| Situation | Skill / command |
|-----------|-----------------|
| Prove a theorem, fill sorries, cycle by cycle | **lean4-prove** — `/lean-prove` |
| Prove unattended until done or out of budget | `/lean autoprove <file>` (runs lean4-prove) |
| Refute a statement: find a counterexample | lean4-prove, "Statement may be false" — `/lean-disprove` |
| Code that does not compile, a broken build, a version bump | **lean4-repair** — `/lean-repair` |
| Shorten, clean up, refactor or speed up working proofs | **lean4-golf** — `/lean-golf` |
| State a result in Lean from maths, notes or a paper | **lean4-formalize** — `/lean-formalize` |
| Review quality, axioms, Mathlib readiness; commit a checkpoint | **lean4-review** — `/lean-review`, `/lean-checkpoint` |
| Anything else in Lean | this skill |

Typical path: formalize → prove (or autoprove) → golf → review → checkpoint.

## The tools in one line each

Full reference: [tools.md](references/tools.md).

- `lean_goal {path, line[, column]}` — goals before/after a line, or at a point. Use constantly.
- `lean_diagnostics {path}` — errors, warnings, sorries; partial results while elaborating.
- `lean_attempt {op: "tactics", path, line, snippets}` — try candidates on a scratch copy;
  `{op: "code", code}` — check standalone code.
- `lean_search {source, query}` — `local`, `leansearch`, `leanfinder`, `loogle`, `premises`.
- `lean_nav {op, path, …}` — hover, completions, definition, references, code actions, outline.
- `lean_verify {op: "axioms"|"sorries", …}` — is it really done.
- `lean_build {}` — `lake build`, skipped when nothing changed.
- `lean_analyze {op: "golf"|"profile"|"hypotheses", path, …}` — improve working proofs.

## Search before you prove

1. **Guess the name** from Mathlib's conventions ([mathlib-guide](references/mathlib-guide.md)):
   `add_comm`, `mul_le_mul_of_nonneg_left`, `Finset.sum_range_succ`. Check it with
   `lean_search {source: "local", query: "..."}` — offline, unlimited.
2. **Describe it**: `lean_search {source: "leansearch", query: "..."}` or `"leanfinder"` (also takes a
   goal pasted as text).
3. **Shape it**: `lean_search {source: "loogle", query: "_ * (_ + _) = _"}`.
4. **Stuck on a goal**: `lean_search {source: "premises", path, line, column}`, then try the names
   in `simp only [...]` / `grind [...]` with `lean_attempt`.
5. Remote sources are rate-limited: on a limit, switch source — never loop. Offline, use `local`
   and `rg -n "theorem .*name" .lake/packages/mathlib/Mathlib`.

[lean-phrasebook](references/lean-phrasebook.md) translates mathematical phrases into Lean.

## Verification ladder

1. **Per edit:** the `[lean auto-check]` line, or `lean_diagnostics {path}`.
2. **Per file, against built imports:** `lake env lean <path/to/File.lean>` from the project root.
   After editing a file other files import, use `lake lean <path>` (rebuilds the imports first) —
   see [File Gate Scope](references/cycle-engine.md#file-gate-scope).
3. **Project:** `lean_build {}` — at checkpoints and at the end, not after every edit.

## Quality gate

A proof is complete when the project builds, there is no `sorry` in the agreed scope
(`lean_verify {op: "sorries"}`), only standard axioms appear (`lean_verify {op: "axioms"}`), and no
statement changed without permission.

## Without a workflow: one bounded pass

When asked to fix or prove one thing without a named workflow:
- read the goal (`lean_goal`) or the error (`lean_diagnostics`);
- search with at most two `lean_search` calls;
- try the automation cascade below with one `lean_attempt` call;
- apply the best candidate and confirm with the auto-check;
- no loops, no commits. If it resists, say so and suggest `/lean-prove` (guided) or
  `/lean autoprove` (unattended).

## Automation cascade

Try in roughly this order (several at once with `lean_attempt`):
`rfl` → `simp` → `ring` → `linarith` → `nlinarith` → `omega` → `positivity` → `exact?` → `apply?` →
`grind` → `aesop`.

`exact?`/`apply?` search the library and are slow; when they succeed, Lean offers the result as a
code action (`lean_nav {op: "code_actions"}`) — replace them with that term before finishing.
`grind` and `aesop` are powerful but can time out; see [grind-tactic](references/grind-tactic.md)
and [simp-reference](references/simp-reference.md). Tactic lookup:
[tactics-reference](references/tactics-reference.md) (search it with `rg "^### TacticName"`).

## Type-class patterns

```lean
-- A local instance for one proof: `have`/`let` register class-typed locals themselves.
have : MeasurableSpace Ω := inferInstance
let inst : Fintype α := ⟨...⟩   -- `let` when the value must stay visible (data)

-- Scoped instances and notation for the current section
open scoped Topology MeasureTheory
```

- `haveI`/`letI` only differ by inlining; in a tactic proof of a proposition they are never needed.
  Reserve `letI` for definitions whose instance value must be inlined into data.
- Check whether synthesis already succeeds before adding a local instance.
- Provide outer structures before inner ones.
- `omit [Inst] in` drops an unused section instance from the next declaration; put it *before* the
  docstring.

Conflicting instances, diamonds and "not definitionally equal" errors:
[instance-pollution](references/instance-pollution.md).

## Files and scratch work

1. The live file, through `lean_goal`, `lean_attempt`, `lean_diagnostics`.
2. `lean_attempt {op: "code"}` for isolated experiments.
3. Never create scratch files in the repository; never leave `#check`/`#eval` in committed files.

Read source with `read` and search it with `rg` (via `bash`); do not write scripts to read files.

## Troubleshooting

- **`lake`/`lean` not found**: install elan (`curl https://elan.lean-lang.org/elan-init.sh -sSf | sh`)
  or point `PI_LEAN_LAKE` at `lake`. `/lean status` shows what the extension found.
- **Toolchain download on first use**: the project's `lean-toolchain` names a version elan has not
  installed; the first Lean call installs it (slow once). Offline mode refuses this.
- **Mathlib project, everything out of date**: fetch the prebuilt cache, `lean_build {fetchCache: true}`
  (or `lake exe cache get` in bash), then build. Never build Mathlib from source by accident.
- **Fresh worktree or after `lake clean`**: fetch the cache in that worktree before the first build;
  do not symlink another worktree's `.lake/build`.
- **Server slow or wedged**: `lean_diagnostics` returns partial results while elaborating; the human
  can run `/lean restart`. A crashed worker restarts on the next call by itself.
- **"Imports are out of date"**: handled automatically (the file's imports are rebuilt once). If it
  persists, an import has errors — `lean_diagnostics` on that file, or `lean_build {}`.
- **Errors you do not recognise**: [compilation-errors](references/compilation-errors.md), then the
  lean4-repair skill.

## References

Read when relevant (large files: search headings with `rg "^## " <file>` first).

- **Tools:** [tools.md](references/tools.md)
- **Process:** [cycle-engine](references/cycle-engine.md) (prove cycles, stuck, escalation, checkpoints),
  [sorry-filling](references/sorry-filling.md)
- **Search:** [mathlib-guide](references/mathlib-guide.md), [lean-phrasebook](references/lean-phrasebook.md)
- **Errors:** [compilation-errors](references/compilation-errors.md),
  [instance-pollution](references/instance-pollution.md),
  [compiler-guided-repair](references/compiler-guided-repair.md),
  [axiom-elimination](references/axiom-elimination.md)
- **Tactics:** [tactics-reference](references/tactics-reference.md),
  [tactic-patterns](references/tactic-patterns.md), [grind-tactic](references/grind-tactic.md),
  [simp-reference](references/simp-reference.md)
- **Proof development:** [proof-templates](references/proof-templates.md),
  [proof-simplification](references/proof-simplification.md),
  [proof-golfing](references/proof-golfing.md),
  [proof-golfing-patterns](references/proof-golfing-patterns.md)
- **Style and review:** [mathlib-style](references/mathlib-style.md),
  [mathlib-review-taxonomy](references/mathlib-review-taxonomy.md)
