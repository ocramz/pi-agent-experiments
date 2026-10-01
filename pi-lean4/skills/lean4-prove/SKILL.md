---
name: lean4-prove
description: "Prove Lean 4 theorems and fill sorry placeholders with a plan, search, test, verify cycle: read the goal, search Mathlib, test candidate tactics with lean_attempt, escalate when stuck, and checkpoint progress. Use when asked to prove a theorem or lemma, fill or remove sorries, or finish an incomplete proof; for /lean-prove and /lean-disprove; and for every cycle of /lean autoprove. Also covers statements that may be false (counterexamples and salvage lemmas). Not for code that fails to compile (lean4-repair) or for stating new results (lean4-formalize)."
license: "MIT (see THIRD_PARTY_NOTICES.md in the pi-lean4 package)"
compatibility: "Requires the pi-lean4 extension (lean_* tools) and a Lean 4 Lake project."
---

# Proving and filling sorries

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

## Modes

| Mode | Started by | Asks the user? | Commits |
|------|-----------|----------------|---------|
| **Guided** | `/lean-prove`, or "prove/fill this" | before each new cycle and each commit | ask |
| **Autoprove cycle** | a message starting `[lean autoprove] cycle k/N` | never | after each verified fill |
| **Single sorry** | "fill the sorry at File.lean:42" | only if blocked | no |
| **Disprove** | `/lean-disprove`, or when evidence says the statement is false | at each decision | no |

## Arguments

`[file[:line] | theorem-name] [--deep=never|ask|stuck] [free-text instructions]`. Without a target,
take every sorry in `.lean` files changed since the last commit (`git diff --name-only`); if that is
empty or ambiguous, ask (guided) or use the file named in the autoprove message.

## Startup

1. **Find the work:** `lean_verify {op: "sorries", path}` and `lean_diagnostics {path}` on the target.
2. **Errors first.** A file that does not compile cannot be proved in: fix errors with the
   lean4-repair skill before filling sorries (unless the error *is* the sorry's goal).
3. **Plan** (guided: show it and wait for "go"): for each sorry, its goal (`lean_goal`), a difficulty
   guess, and the first search or candidate to try. Order easy ones first; note dependencies
   between sorries.

## The cycle

Each cycle: **plan → work → checkpoint → (review) → replan → continue/stop**. Details:
[cycle-engine](../lean4/references/cycle-engine.md#six-phase-cycle).

| Phase | Guided | Autoprove cycle |
|-------|--------|-----------------|
| Plan | show, wait for approval | decide silently |
| Work | up to all sorries in scope | at most 2 sorries |
| Checkpoint | ask before committing | commit verified fills |
| Review | every few cycles, or when stuck | when stuck |
| Continue | ask: continue / stop / adjust | end the turn with the status block |

## Work: one sorry

1. **Goal:** `lean_goal {path, line}` at the sorry. Read the hypotheses — the answer is often in them.
2. **Search** (at most two calls): `lean_search {source: "local"}` for a guessed name, then
   `leanfinder`/`leansearch` with the goal or its statement in words; `premises` when stuck.
3. **Candidates** (2–3, varied): a direct term (`exact foo h`), a tactic (`simp [foo]`, `omega`,
   `linarith`), automation (`aesop`, `grind`), one built from a search hit.
4. **Test them together:** `lean_attempt {op: "tactics", path, line, snippets: [...]}`.
5. **Apply** the shortest candidate that closes the goal with `edit`. If none closes it but one
   leaves simpler goals, apply it and recurse on the new goals.
6. **Confirm** with the auto-check (or `lean_diagnostics`). If a `[suggestion]` appears ("Try this"),
   take it: `lean_nav {op: "code_actions", path, line}` and apply the edit.

**Limits per sorry:** 3 candidate rounds, a diff of at most ~80 lines, no edits to other files, no
header changes. Trivial goals (`rfl`, `simp`, `omega`, `decide` on small numbers) — try them first,
in one call. More patterns: [sorry-filling](../lean4/references/sorry-filling.md),
[tactic-patterns](../lean4/references/tactic-patterns.md).

**Falsification preflight.** If the goal is decidable or about small finite values and nothing
works, spend one call checking it is even true: `lean_attempt {op: "code"}` with `#eval` or `decide`
on concrete instances. A counterexample means: go to "Statement may be false".

## Stuck triage

A sorry is **stuck** when the same failure happens 2–3 times, the same error twice, two searches
come back empty, or there is no progress after ~10 minutes of work on it.

Classify the blocker, then probe at most three times along that line:

| Blocker | Probe |
|---------|-------|
| definitional equality | `show` the intended form; `unfold`/`simp only [defs]`; `rfl` after `norm_num` |
| missing intro / constructor / cases | `lean_goal` after `intro`, `constructor`, `rcases h with ⟨…⟩` |
| missing rewrite | `rw [?]`: search for the equation (`loogle` with the shape) |
| arithmetic | `omega` (ℕ, ℤ), `linarith`/`nlinarith` with the needed facts, `positivity`, `norm_num` |
| missing library lemma | `leanfinder` with the goal text; `premises` at the goal |
| type class / coercion / elaboration | `push_cast`, `norm_cast`, explicit `(x : ℝ)`, `@foo _ _ inst` |
| needs a helper lemma | state it (same file, above), `sorry` it, use it, then prove it |

Record for the report: the goal, the searches tried, the best candidates and how they failed.
Guided: present a fresh plan and ask before continuing. Autoprove: mark the sorry stuck and move to
the next one; do not return to it unless new evidence appears.

## Escalation pass

For a stuck sorry, when `--deep` allows it (guided default `ask`, autoprove `stuck`), one bounded
deeper attempt in this session:

1. **Plan first:** write the proof outline as comments or `have` steps with `sorry`.
2. **Helpers** go in the same file, above the theorem, with full statements. No new imports
   unless they are clearly needed; never touch other files' declarations.
3. **Header fence:** declaration headers stay byte-identical. If the statement looks wrong, stop and
   say so (redraft belongs to lean4-formalize).
4. **Budget:** at most ~120 changed lines (guided) or ~200 (autoprove), one pass.
5. **Snapshot = the text you read before starting.** If the pass leaves more sorries or new errors,
   restore that text with `edit`, mark the sorry stuck, and report.

See [cycle-engine § Deep Mode](../lean4/references/cycle-engine.md#deep-mode).

## Compile errors met while proving

Fix the error directly (it is usually your last edit). Then hand over to the lean4-repair skill's
loop. Budget: 2 attempts per distinct error, 6 (guided) / 8 (autoprove) repairs per cycle; past
that, revert your edit and mark the sorry stuck.

## Statement may be false

When evidence suggests the statement is false (a counterexample from `#eval`, `decide` refuting an
instance, a goal reducing to `False`):

1. **Never rewrite the original.** Leave its `sorry`; work append-only, below it.
2. **Find a witness** with `lean_attempt {op: "code"}`: `#eval`/`decide` on small cases, `Nat.find`
   style searches, specific values.
3. **Certify it.** Add a theorem in the file:

   ```lean
   theorem foo_counterexample : ¬ (∀ n : ℕ, P n) := by
     intro h
     have := h 3
     norm_num at this
   ```

   Report **REFUTED** only when it compiles (`lake env lean <file>`) and
   `lean_verify {op: "axioms", path, name: "foo_counterexample"}` is standard — no `native_decide`
   unless the user allows it.
4. **Salvage** (optional): `foo_salvaged` with the extra hypothesis that makes it true.
5. Otherwise report **WITNESS_UNCERTIFIED** (a witness Lean has not checked) or **INCONCLUSIVE**.

For `/lean-disprove`, this section is the whole workflow; do not try to prove the statement.

## Checkpoint commits

After a verified fill (auto-check clean, the sorry gone):

- Guided: show `git diff --stat` for the touched files and ask `[yes / yes-all / no / never]`.
  `no` leaves the change uncommitted; unstage with `git restore --staged <files>` if you staged it.
- Autoprove: commit when the cycle's fills are verified.

```bash
git add Path/To/File.lean
git commit -m "prove(lean4): fill <theorem name>"
```

Never commit a file with new errors; never push, amend or rewrite history.

## Autoprove cycle

`/lean autoprove <file>` runs this skill repeatedly. The extension measures sorries and errors after
every turn and decides whether to continue (budgets: cycles, stuck cycles in a row, running time);
you do one cycle per turn:

1. Never ask the user anything; make the reasonable choice and note it.
2. Read the `[lean autoprove]` message: target file, cycle number, what was measured, the first
   remaining problem.
3. Errors first, then at most **2 sorries**, skipping ones marked stuck unless the message brings
   new evidence.
4. Per sorry: the "Work: one sorry" steps; at most one escalation pass.
5. Gate the file (auto-check clean, or `lake env lean <file>`), commit the verified fills.
6. End the turn with:

```
<autoprove-status>
filled: <declaration names | none>
remaining: <n>
stuck: yes|no
blocker: <file:line> <class from the stuck table> <one line> | none
committed: yes|no
next: <one line>
</autoprove-status>
```

When the loop stops, the extension sends a summary; answer with the session summary below.

## Session summary

```
Filled: 5/8 sorries (theorems: ...)
Stuck: 2 — Foo.bar (needs a helper lemma about ...), Foo.baz (missing library lemma)
Counterexamples: 1 (foo_counterexample)   Commits: 4   Files touched: A.lean, B.lean
Next: ...
```

Then suggest the lean4-golf skill on the touched files and `/lean-checkpoint`.

## References

[sorry-filling](../lean4/references/sorry-filling.md) ·
[cycle-engine](../lean4/references/cycle-engine.md) ·
[tactics-reference](../lean4/references/tactics-reference.md) ·
[tactic-patterns](../lean4/references/tactic-patterns.md) ·
[grind-tactic](../lean4/references/grind-tactic.md) ·
[simp-reference](../lean4/references/simp-reference.md) ·
[mathlib-guide](../lean4/references/mathlib-guide.md) ·
[tools.md](../lean4/references/tools.md)
