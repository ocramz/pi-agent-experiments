---
name: lean4-repair
description: "Fix Lean 4 code that does not compile, with minimal verified diffs: type mismatch, unknown identifier or constant, failed to synthesize instance, unsolved goals, deterministic timeout or heartbeats, coercion and universe errors, proofs broken by a Lean or Mathlib upgrade, and lake build failures. An error-driven loop with per-error strategies and attempt budgets; also eliminates custom axioms. Use when diagnostics show errors in existing Lean code, or for /lean-repair. Not for filling intentional sorries (lean4-prove)."
license: "MIT (see THIRD_PARTY_NOTICES.md in the pi-lean4 package)"
compatibility: "Requires the pi-lean4 extension (lean_* tools) and a Lean 4 Lake project."
---

# Repairing Lean code that does not compile

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

## The loop

Work on **one error at a time, earliest first** — later errors are often consequences.

1. **Classify.** `lean_diagnostics {path}` for the message; `lean_goal {path, line}` at the error for
   the state. Match the message against the table below and
   [compilation-errors](../lean4/references/compilation-errors.md).
2. **Fix directly** if the cause is obvious (a typo, a renamed lemma, a missing argument).
3. **Otherwise search, then test candidates together:** `lean_search` for the missing lemma or
   instance; then `lean_attempt {op: "tactics", path, line, snippets: [...]}` with 2–4 fixes, e.g.
   the cascade `simp`, `omega`, `linarith`, `exact?`, `aesop`, `grind`.
4. **Apply the smallest diff** (1–5 lines) with `edit`.
5. **Verify** with the auto-check; the error count must go down and no new error appear. Otherwise
   restore your previous text with `edit` and try the next strategy.
6. **Next error.** When the file is clean, run the file gate (`lake env lean <file>`, or
   `lake lean <file>` after editing an imported file).

Escalation and the full error-driven method:
[compiler-guided-repair](../lean4/references/compiler-guided-repair.md).

## Strategy by error

| Error | First moves |
|-------|-------------|
| `type mismatch` | `convert _ using N`; a type ascription `(e : T)`; `refine`; `rw [..] at h`; check coercions (`↑`, `push_cast`) |
| `unsolved goals` | `lean_goal` to see what is left; `simp?`, `exact?`, `constructor`, `use`, `intro` |
| `unknown identifier` / `unknown constant` | `lean_search {source: "local"}` for the name; a rename after a Mathlib bump (search the old name's statement); a missing `open`/`import`; the namespace |
| `failed to synthesize` | is the instance in scope (`open scoped …`, an import)?; a local `have : Inst := …`; argument order; [instance-pollution](../lean4/references/instance-pollution.md) |
| `deterministic timeout` / heartbeats | `simp only [...]` instead of `simp`; split with `have`; `clear` unused hypotheses; explicit instances; last resort `set_option maxHeartbeats N in` on that declaration |
| `motive is not type correct` | `rw` cannot rewrite under a dependency: `simp only`, `subst`, `generalize`, or `conv` |
| universe errors | explicit universe variables; `ULift`; check `Sort*` vs `Type*` |
| `Function expected` | a missing `(`…`)` or an argument applied to a non-function; check implicit vs explicit arguments |
| `linter` warnings | not errors; fix only if asked |

## Budgets and stuck

| Stage | What | Attempts |
|-------|------|----------|
| Fast | obvious fixes, one at a time | ≤ 6 |
| Precise | search, read the surrounding API, rethink the step | ≤ 18 |

Within a prove cycle the cycle's budgets win: at most 2 attempts per distinct error and 6–8 repairs
per cycle ([cycle-engine § Repair Mode](../lean4/references/cycle-engine.md#repair-mode)).
**Progress** means fewer errors, or the same count with the first error later in the file.

Stuck (the same error after 3 tries, or the budget spent): stop, restore the file to the last state
that had fewer errors, and report the error, the goal, and what you tried.

## Never

- Change a declaration header or statement to make an error go away — that changes the theorem.
  If the statement is the problem, say so (lean4-formalize).
- Replace a failing proof with `sorry`, add an `axiom`, or use `native_decide` to hide an error.
- Rewrite whole proofs to fix one error, or try random tactics without reading the goal.
- Skip the search when the error is about a name or an instance.
- Edit other files' declarations to fix this file (except fixing an import that is itself broken).

## Lake and build failures

- **"Imports failed to build"** lists files with errors: repair those first (they are upstream).
- **`lake env lean` reports stale imports** after you edited an imported file: use `lake lean <file>`
  (it rebuilds the imports), or `lean_build {}` — see
  [File Gate Scope](../lean4/references/cycle-engine.md#file-gate-scope).
- **Mathlib out of date / everything rebuilding**: `lean_build {fetchCache: true}` (downloads the
  prebuilt cache) before building; never build Mathlib from source by accident.
- **After a Lean or Mathlib bump**: renamed lemmas are the usual cause — search the old statement,
  not the old name; check Mathlib's deprecation aliases (`@[deprecated]` points to the new name).
- **Module-system errors** (`public`, `meta`, `import all`): see
  [compilation-errors](../lean4/references/compilation-errors.md).
- **Build logs**: `lean_build` returns the errors and the last lines; for the full log run
  `lake build 2>&1 | tail -100` in bash.

## Axiom hygiene

`lean_verify {op: "axioms", path, name}` after repairs. A custom axiom — one the project declares —
is a promise nobody kept:

1. **Inventory:** `lean_verify {op: "axioms", path}` per file; `lean_nav {op: "references"}` on each
   axiom for its uses.
2. **Order:** axioms Mathlib already proves (search the statement), then ones composable from Mathlib
   lemmas, then structural ones.
3. **Replace** each with a theorem: import-and-use, or prove it; if it cannot be proved now, turn it
   into `theorem … := by sorry` (honest: it shows up as `sorryAx`) and report it.
4. **Verify** the axiom count went down after each replacement.

Details: [axiom-elimination](../lean4/references/axiom-elimination.md).

## Report

```
Fixed: 4 errors in Foo.lean (renamed lemma ×2, coercion, missing instance)
Remaining: 1 — Foo.lean:88 type mismatch (needs the statement to use ℝ≥0∞, not ℝ: a header change)
Files touched: Foo.lean
```

## References

[compilation-errors](../lean4/references/compilation-errors.md) ·
[compiler-guided-repair](../lean4/references/compiler-guided-repair.md) ·
[instance-pollution](../lean4/references/instance-pollution.md) ·
[axiom-elimination](../lean4/references/axiom-elimination.md) ·
[cycle-engine](../lean4/references/cycle-engine.md) ·
[tools.md](../lean4/references/tools.md)
