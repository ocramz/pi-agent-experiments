---
name: lean4-golf
description: "Improve Lean 4 proofs that already compile, without changing any statement: golf and shorten proofs, make them more direct, replace hand-rolled arguments with Mathlib lemmas, extract helper lemmas, narrow simp calls, and speed up slow proofs using profiling. Every change is verified and reverted on failure. Use when asked to golf, simplify, clean up, refactor or optimize working Lean proofs, or for /lean-golf. Not for proofs with errors or sorries."
license: "MIT (see THIRD_PARTY_NOTICES.md in the pi-lean4 package)"
compatibility: "Requires the pi-lean4 extension (lean_* tools) and a Lean 4 Lake project."
---

# Golfing, refactoring and speeding up proofs

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

## Arguments

`[file[:line]] [--dry-run] [--search=off|quick|full] [--refactor]`. `--dry-run` reports candidates
and does not edit. `--search` controls the lemma-replacement pass (default `quick`). `--refactor`
adds the strategy-level pass below.

## Preconditions

The file must compile: `lean_diagnostics {path}` shows no errors (sorries are allowed only outside the
declarations you golf). Golfing a broken file hides regressions. Note the baseline: error count
(zero), sorry count, warning count.

## Workflow

1. **Find candidates:** `lean_analyze {op: "golf", path}` lists places by pattern with a priority.
   Also read the file: long `have` chains, `calc` blocks of trivial steps, repeated tactic blocks.
2. **Exact-collapse pass** (at most ~30 places per file): for `apply`/`exact` chains and
   `by exact` wrappers, build the collapsed term and test it with
   `lean_attempt {op: "tactics", path, line, snippets: [...]}`. Accept only if more direct or clearer.
3. **Lemma replacement** (`--search` not `off`): for a hand-rolled argument, search for the lemma
   that states it (`lean_search` local, then leanfinder/loogle); `quick` = 1 search and ≤ 2
   candidates per place, `full` = 2 searches and ≤ 3. Test each with `lean_attempt`.
4. **Let/have inlining:** count the uses first (`lean_nav {op: "references"}` on the binder, or read
   the proof): 1–2 uses → inline; 3–4 → only if clearer; 5+ → never.
5. **Apply** one change at a time with `edit`; the auto-check must stay clean (no new errors,
   sorries or warnings). Otherwise restore the previous text with `edit` immediately.
6. **Report** (below). Do not commit; suggest `/lean-checkpoint`.

## Patterns

**Instant wins** (always, after testing):

| Before | After |
|--------|-------|
| `ext x; rfl` | `rfl` |
| `simp; rfl` | `simp` |
| `constructor; exact h1; exact h2` | `exact ⟨h1, h2⟩` |
| `apply f; exact h` | `exact f h` |
| `:= by exact t` (declaration right-hand side) | `:= t` |

**Safe with verification:** inline a `let` used ≤ 2 times; inline a one-line `have` used once;
close a `calc` of trivial steps with `linarith`/`gcongr`/`positivity`; `constructor <;> simp` for
literally identical goals.

**Skip:** lets used 3+ times; complex `have` blocks; names that appear in error messages or that
document the argument. More: [proof-golfing](../lean4/references/proof-golfing.md),
[proof-golfing-patterns](../lean4/references/proof-golfing-patterns.md).

## Policy

**Scoring.** A candidate must compile and not be rejected. Among those prefer, in order: (1) a more
direct proof shape, (2) less inference/search burden, (3) better performance and determinism,
(4) shorter code. Burden ladder: `rfl`/`exact` < `rw`/`apply` < `simp only` < `simpa`/`rwa` < broad
`simp`/`decide`/`omega`/`grind`.

**Hard reject** a candidate that:
- introduces a bare `;`, or `<;>` on goals that are not literally identical;
- moves up the burden ladder for a one-line saving;
- removes meaningful names;
- makes a term longer than ~80 characters or a dot-chain deeper than 2;
- replaces `exact t` with `simpa using t` while `exact t` works;
- turns a terminal `simp` into `simp only` (or the reverse) without the user's preference — narrowing
  a *non-terminal* `simp` to `simp only` is always fine.

`;`-separated tactics count as separate lines: semicolons are not savings.

## Bulk rewrites

Only for whitelisted syntax at declaration right-hand sides (`:= by exact t` → `:= t`, `by rfl` →
`rfl`), never inside tactic or `calc` blocks, and only when there are ≥ 4 of them in a file:
1. preview the match count and 3–5 sample hunks; wait for the user's confirmation;
2. apply at most 10 replacements (≤ 3 hunks × 60 lines) per file;
3. compare `lean_diagnostics` with the baseline; any new message or extra sorry → restore the batch.

## Saturation and limits

Stop when fewer than 1 in 5 attempts succeed, or the last 3 failed. Per pass: at most 3 hunks of
60 lines per file. Never edit statements; a candidate that would need one is rejected and reported.

## Refactor (strategy level)

With `--refactor`, or when asked to "refactor"/"simplify the approach":

1. **Audit:** proofs over ~30 lines, repeated blocks, hand-rolled facts Mathlib has.
2. **Search** the Mathlib lemma or abstraction that makes the argument short
   ([proof-simplification](../lean4/references/proof-simplification.md)).
3. **Plan** batches (extract a helper lemma, replace a block with a library lemma, generalise a
   repeated argument) and show them; wait for approval per batch.
4. **Apply** a batch; verify with the auto-check and `lake lean <file>` (the batch may touch helpers
   other files use); on a regression, restore the batch.

## Performance

For proofs that are slow or near the heartbeat limit:
1. `lean_analyze {op: "profile", path, line}` — the slowest lines and categories.
2. Typical fixes: `simp` → `simp only [...]` (use `simp?` and its code action to get the list),
   replace `decide` on large instances, give explicit instances, split with `have`, avoid `aesop`/
   `grind` on large contexts (`clear` what is unused).
3. Re-profile to confirm.

`lean_analyze {op: "hypotheses", path, name}` reports explicit hypotheses the proof does not use.
Removing one changes the statement: report it, never apply it unasked.

## Report

```
Golf results for Foo.lean
Meaningful simplifications: 3 (directness)   Performance: 1 (simp narrowing)
Syntax cleanups: 1 (by exact → term)          Skipped: 2 (1 safety, 1 marginal)
Build: passing                                 Savings: 8 lines (~12%)
Unused hypotheses (not removed): Foo.bar (h₂)
```

## References

[proof-golfing](../lean4/references/proof-golfing.md) ·
[proof-golfing-patterns](../lean4/references/proof-golfing-patterns.md) ·
[proof-simplification](../lean4/references/proof-simplification.md) ·
[simp-reference](../lean4/references/simp-reference.md) ·
[mathlib-style](../lean4/references/mathlib-style.md) ·
[tools.md](../lean4/references/tools.md)
