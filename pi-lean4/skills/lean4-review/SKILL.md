---
name: lean4-review
description: "Read-only review of Lean 4 work, plus verified checkpoint commits. Review: build status, remaining sorries, non-standard axioms, Mathlib style and naming, docstrings, golf opportunities, Mathlib PR readiness, or triage of why a proof is stuck. Checkpoint: compile the touched files, lake build, axiom and sorry scan, then commit only the touched files. Use when asked to review, audit or check axioms of Lean code, or to checkpoint, save or commit Lean progress; for /lean-review and /lean-checkpoint."
license: "MIT (see THIRD_PARTY_NOTICES.md in the pi-lean4 package)"
compatibility: "Requires the pi-lean4 extension (lean_* tools) and a Lean 4 Lake project."
---

# Reviewing and checkpointing Lean work

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

## Review is read-only

A review never edits, stages or commits. It reports findings and proposed replacement text; the
user (or another workflow) applies them.

## Arguments and scope

`[file[:line]] [--stuck] [--mathlib] [--scope=sorry|file|changed|project]`

| Scope | Covers |
|-------|--------|
| `sorry` | one sorry and its declaration (default with `file:line`) |
| `file` | one file (default with a file) |
| `changed` | `.lean` files changed since the last commit, `git diff --name-only HEAD` (default without a target) |
| `project` | every `.lean` file outside `.lake` |

## Layer 1 — proof hygiene (always)

| Check | How |
|-------|-----|
| Build status | `lean_diagnostics {path}` per file; `lake env lean <file>`; `lean_build {}` for `project` scope |
| Sorries | `lean_verify {op: "sorries", path}` |
| Axioms | `lean_verify {op: "axioms", path}` — anything but `propext`, `Classical.choice`, `Quot.sound` is a finding |
| Style | Mathlib conventions: names, 100-character lines, `fun x ↦`, tactic style ([mathlib-style](../lean4/references/mathlib-style.md)) |
| Golf opportunities | `lean_analyze {op: "golf", path}` |
| Complexity | `lean_nav {op: "outline", path}` — the longest proofs, deeply nested `have` chains |

Errors, sorries and non-standard axioms are **blockers**; the rest is hygiene.

## Layer 2 — Mathlib review

Strict (findings next to Layer 1) when `--mathlib` is given or the project is Mathlib itself (its
lakefile names the `mathlib` package). Otherwise these are **advisory** and go under a separate
"Advisory (Mathlib style)" heading — never mixed with blockers.

1. **Documentation:** module docstring (`/-! … -/`), docstrings on public declarations, a proof
   sketch on intricate arguments.
2. **Library integration:** is there a more general existing result (search for it)? Is the file
   placement right? Are imports heavier than needed?
3. **API and generality:** weakest reasonable hypotheses (`lean_analyze {op: "hypotheses"}` reports
   unused ones); structures vs. conjunctions; names that follow the conclusion.
4. **Attributes and instances:** is each `@[simp]` a good simp lemma (LHS in normal form, terminates)?
   Diamond risk in new instances; `@[ext]`, `@[reducible]` used deliberately.

Vocabulary and examples: [mathlib-review-taxonomy](../lean4/references/mathlib-review-taxonomy.md).

## Stuck mode

`--stuck` (or "why is this stuck?"): blockers only, for one sorry. Report the goal (`lean_goal`),
the blocker class from [lean4-prove's stuck triage](../lean4-prove/SKILL.md#stuck-triage), what has
been tried (from the conversation), and the top 3 next moves, most promising first. Allow one Layer-2
point only if it is the main reason the proof will not survive review.

## Report format

```markdown
## Lean review — Foo.lean (scope: file)

### Build: ✓ compiles
### Sorries (2)
| Line | Declaration | Suggestion |
|------|-------------|------------|
| 42 | Foo.bar | `linarith [h₁, h₂]` closes it per lean_attempt |

### Axioms: ✓ standard only
### Style
- 17: name `foo_lemma_2` — conclusion-based name `bar_le_baz`
### Golf
- 88: `apply f; exact h` → `exact f h`

### Advisory (Mathlib style)
- missing module docstring

### Next
1. ... 2. ...
```

## After the review

| Finding | Route to |
|---------|----------|
| errors | lean4-repair (`/lean-repair`) |
| sorries | lean4-prove (`/lean-prove`) or `/lean autoprove <file>` |
| golf / style | lean4-golf (`/lean-golf`) |
| custom axioms | lean4-repair, axiom hygiene |
| wrong statements | lean4-formalize |
| clean | `/lean-checkpoint` |

## Checkpoint

`/lean-checkpoint [message]`: a verified save point. Unlike review it commits — only the files
this session touched.

1. **Candidate set:** the `.lean` files edited in this session (from the conversation), confirmed
   against `git status --porcelain`. Never stage files you did not touch.
2. **File gate:** `lake env lean <file>` for each (from the project root); after edits to files that
   others import, `lake lean <file>` instead
   ([File Gate Scope](../lean4/references/cycle-engine.md#file-gate-scope)).
3. **Library roots:** only if `.lean` files were added or removed under a library root that imports
   every module (Mathlib style), check with `lake exe mk_all --check` (if the project has it); report
   a mismatch, do not rewrite roots automatically.
4. **Project gate:** `lean_build {}`. It must pass.
5. **Axioms and sorries:** `lean_verify {op: "axioms", path}` per touched file and
   `lean_verify {op: "sorries"}`. Sorries are reported (a checkpoint may contain them if the user
   agreed); non-standard axioms block the checkpoint unless the user accepts them explicitly.
6. **Commit:**

```bash
git add Foo/Bar.lean Foo/Baz.lean
git diff --cached --name-only
git commit -m "checkpoint(lean4): fill Foo.bar, golf Foo.baz"
```

Print the staged set before committing. Never push, amend, open a pull request, or rewrite history.
If a gate fails, stop and report which one; nothing is committed. To undo a checkpoint, the user
reverts it themselves (`git revert <commit>`).

## References

[mathlib-style](../lean4/references/mathlib-style.md) ·
[mathlib-review-taxonomy](../lean4/references/mathlib-review-taxonomy.md) ·
[cycle-engine](../lean4/references/cycle-engine.md#checkpoint-logic) ·
[proof-golfing](../lean4/references/proof-golfing.md) ·
[tools.md](../lean4/references/tools.md)
