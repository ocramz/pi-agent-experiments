---
name: lean4-formalize
description: "Translate informal mathematics into Lean 4: draft theorem and definition statements from a natural-language claim, notes, a paper or a PDF; choose Mathlib types, names and hypotheses; check that the skeleton elaborates; then optionally prove it under a chosen rigor level with an assumption ledger. Also batch-drafts several claims from one source. Use when the user wants to formalize, state or encode a mathematical result in Lean, or for /lean-formalize."
license: "MIT (see THIRD_PARTY_NOTICES.md in the pi-lean4 package)"
compatibility: "Requires the pi-lean4 extension (lean_* tools) and a Lean 4 Lake project."
---

# Formalizing mathematics in Lean

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

Formalizing is the one workflow allowed to *write* statements — the declarations it creates in this
session. Statements that already exist stay under the ground rules.

## Modes

| Mode | Result |
|------|--------|
| `skeleton` (default) | statements with `sorry` proofs that elaborate |
| `attempt` | skeleton, plus one bounded proof attempt per declaration (`lean_attempt`) |
| `prove` | skeleton, then the lean4-prove skill in guided mode on it |
| batch from a source | every claim in a source drafted as skeletons, then suggest `/lean autoprove <file>` |

## Arguments

`<claim | --source=PATH|URL> [--mode=skeleton|attempt|prove] [--out=FILE] [--rigor=checked|sketch|axiomatic] [--claim=first|named:"Theorem 3.2"|regex:"..."]`

## Inputs and outputs

- **Output** goes to the chat by default; to a scratch file `.scratch/lean4/draft-<time>.lean` on
  request (warn if `.scratch/` is not git-ignored); or to `--out=FILE`.
- Never overwrite an existing file unless asked; write only inside the workspace.
- Read the claim from the message, or from `--source`: `read` for text files, `pdftotext src.pdf -`
  (bash) for PDFs, `curl -sL URL` for web pages. If a source cannot be read, ask for the excerpt.
- From a source with several claims, select with `--claim` (`first`, `named:"…"`, `regex:"…"`), or
  ask; batch mode drafts them all.

## Drafting

1. **Restate the claim precisely** in words: objects, quantifiers, hypotheses, conclusion.
2. **Find the vocabulary** in Mathlib: `lean_search {source: "leanfinder"}` for concepts ("a function
   continuous on a compact set is bounded"), `local` for names, `loogle` for shapes. Prefer existing
   definitions (`IsCompact`, `Finset.sum`, `Nat.Prime`) to new ones; see
   [lean-phrasebook](../lean4/references/lean-phrasebook.md) and
   [mathlib-guide](../lean4/references/mathlib-guide.md).
3. **Write the statement** with `sorry` as the proof, following Mathlib naming
   ([mathlib-style](../lean4/references/mathlib-style.md)).
4. **Check it elaborates:** `lean_attempt {op: "code", code}` with the imports, or write it to the
   target file and read the auto-check. An elaboration error is a statement bug — fix it before
   anything else.
5. **Show the statement side by side** with the informal claim.

## Fidelity checklist

Before calling a statement right, check each item against the informal claim:

- **Quantifiers and their order** (`∀ ε > 0, ∃ δ > 0, …`), and which variables are implicit.
- **Types:** ℕ vs ℤ vs ℝ; natural subtraction and division truncate (`5 - 7 = 0` in ℕ); `x / 0 = 0`.
- **Coercions** where the informal text silently mixes number systems.
- **Edge cases** the informal statement excludes by convention (n = 0, empty sets, degenerate
  intervals): add them as hypotheses rather than proving a false statement.
- **Strength:** not weaker (would be trivially true) and not stronger (would be false) than meant.
- **Sanity test:** `#eval`/`decide` on small instances with `lean_attempt {op: "code"}`; try to prove
  the negation of an easy special case — if that succeeds, the statement is wrong.

## Rigor and the assumption ledger

| Rigor | `sorry` | errors | non-standard axioms | silent global axioms |
|-------|---------|--------|---------------------|----------------------|
| `checked` (default) | not allowed | not allowed | not allowed | never |
| `axiomatic` | not allowed | not allowed | only as listed hypotheses | never |
| `sketch` | allowed | allowed | allowed | never |

- Assumptions are **parameters of the theorem** (`(h_cont : Continuous f)`), never global `axiom`s.
- Under `axiomatic`, list every assumption the informal source did not state:

```lean
-- Assumption ledger
-- h_cont : Continuous f   — stated in the claim          (user-stated)
-- h_bdd  : IsBounded S    — needed for compactness step  (assistant-inferred)
```

- A `sketch` result starts with `-- ⚠ NOT VERIFIED — sketch only`.
- Before presenting a final result, run `lean_verify {op: "axioms", path}` and report the verdict.

## Statement mismatch

If proving shows the statement is wrong (a counterexample, a missing hypothesis), offer:

1. **Redraft** — revise the statement (this workflow may change declarations it created);
2. **Salvage** — add `T_salvaged` with the extra hypothesis, keep the original;
3. **Preserve and stop** — keep the statement with its `sorry`, report why;
4. **Continue** — keep trying as is.

Never change a statement that existed before this session without the user's explicit approval.

## File shape

- New files: imports, then a module docstring (`/-! # Title … -/`), then `namespace`, the
  declarations, `end`. New declarations get docstrings; existing ones are not touched.
- Use the Mathlib file header (copyright, `module`, imports) only when the project *is* Mathlib or the
  user asks ([mathlib-style § 1](../lean4/references/mathlib-style.md)).
- A new file in a library whose root imports every module may need the root updated
  (`lake exe mk_all` in Mathlib-style repositories); say so rather than editing roots unasked.
- Add the file to the build only if the lakefile's globs do not already cover it.

## Proving after drafting

`--mode=prove` hands over to the lean4-prove skill (guided) on the drafted declarations; batch
drafts suggest `/lean autoprove <file>`. Either way the statements are frozen once proving starts
(the header fence); a needed change comes back here as a statement mismatch.

## Output

```
Claim: "Every continuous function on [a, b] is bounded."
Lean:
  theorem bounded_of_continuousOn {a b : ℝ} {f : ℝ → ℝ} (hf : ContinuousOn f (Set.Icc a b)) :
      ∃ C, ∀ x ∈ Set.Icc a b, |f x| ≤ C := by
    sorry
Elaborates: yes (lean_attempt)   Rigor: checked   Axioms: n/a (unproved)
Notes: closed interval made explicit; a ≤ b not needed (empty interval is fine).
```

## References

[lean-phrasebook](../lean4/references/lean-phrasebook.md) ·
[mathlib-guide](../lean4/references/mathlib-guide.md) ·
[mathlib-style](../lean4/references/mathlib-style.md) ·
[proof-templates](../lean4/references/proof-templates.md) ·
[cycle-engine](../lean4/references/cycle-engine.md#synthesis-outer-loop) ·
[tools.md](../lean4/references/tools.md)
