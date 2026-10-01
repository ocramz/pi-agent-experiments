# Compiler-Guided Proof Repair - Quick Reference

**Core insight:** Use Lean's compiler feedback to drive iterative repair with small, targeted attempts instead of blind best-of-N sampling.

**Key principle:** Generate → Compile → Diagnose → Fix → Verify (tight loop, one candidate set per error)

**Inspired by:** APOLLO (https://arxiv.org/abs/2505.05758)

---

## Philosophy

**Blind sampling** generates many attempts, tests all, picks the best: most fail identically, nothing is learned, and it is expensive.

**Compiler-guided repair** routes each Lean error to a specific fix and retries:
- **Error-driven:** different fix strategies per error type
- **Automation first:** a cascade of closing tactics handles many cases mechanically
- **Small batches:** a few targeted candidates per attempt, verified immediately
- **Early stopping:** bail after the same error repeats, so the loop never runs away
- **Memory:** note what was tried so dead ends are not repeated

---

## When to Use

Repair is **escalation-only**: it applies when compiler errors are the active blocker and LSP-first tactics cannot resolve them (same blocker 2x, same build error 2x, or 3+ errors). It is not the default response to a first failure, and single obvious errors (missing import, coercion, typo) are fixed directly. See [cycle-engine.md § Repair Mode](cycle-engine.md#repair-mode) for triggers and budgets; `/lean-prove` and `/lean autoprove` enter it from their work phase.

---

## API Discovery Workflow

**Core principle:** Search before guessing. Semantic search plus the LSP prevents most API-related errors.

### The "LeanFinder First" Rule

Before writing ANY Lean API call:

1. **Search with natural language:** `lean_search {source: "leanfinder", query: "Lp space membership predicate measure theory"}` → finds `MemLp` (not `Memℒp`, not `memLp`)
2. **Confirm locally:** `lean_search {source: "local", query: "MemLp"}` → verify it exists in your imports
3. **Check the signature:** `lean_nav {op: "hover", path, line, column}` → `MemLp f p μ` expects `ENNReal`, not `ℝ`
4. **THEN write the code**

**Why this matters:**
- Mathematical notation ≠ Lean API names (ℒp → MemLp, not Memℒp)
- Type signatures have subtle requirements (`ENNReal.ofReal 2` vs `2`)
- Field vs function matters (`x.foo` vs `Foo.bar x`)

### Example: Lp Space API Discovery

**❌ Wrong (guessing from math notation):**
```lean
theorem foo (f g : α → ℝ) (h : f =ᵐ[μ] g) : f ∈ Memℒp 2 μ := by
  exact h.memLp  -- Multiple errors: Memℒp doesn't exist, memLp is not a field, 2 has wrong type
```

**✅ Correct (LeanFinder → hover → verify):**
```lean
theorem foo (f g : α → ℝ) (hf : MemLp f (ENNReal.ofReal 2) μ) (h : f =ᵐ[μ] g) :
    MemLp g (ENNReal.ofReal 2) μ := by
  exact MemLp.ae_eq hf h.symm  -- Correct API name, correct type, correct direction
```

How the search helped: "Lp space membership predicate" → `MemLp`; hover on `MemLp` → `p` is `ENNReal`; local search "ae_eq" → `MemLp.ae_eq` takes `f =ᵐ[μ] g` (not `g =ᵐ[μ] f`).

---

## Core Workflow

```
1. lean_diagnostics {path}            → take the FIRST error (later ones often cascade from it)
2. lean_goal {path, line}             → goal and local context at the error (kind: "term" in term mode)
3. lean_attempt {op: "tactics", path, line, snippets: [...]}  → cascade + targeted fixes for that error type
4. edit the shortest passing snippet in (a 1-5 line diff)
5. lean_diagnostics {path}            → error gone and nothing new? if not, revert with edit
6. repeat from 1; `lake env lean <file>` as the file gate, `lean_build` at checkpoints
```

**The cascade** (try as one `lean_attempt` batch before writing anything by hand): `rfl`, `simp`, `ring`, `linarith`, `nlinarith`, `omega`, `exact?`, `apply?`, `grind`, `aesop`. A suggestion tactic (`exact?`, `apply?`) is only a probe — install the concrete term it suggests and re-verify.

**Escalate within the loop** when the same error appears 3 times, or for `synth_instance`, `recursion_depth` and `timeout` errors: stop pattern-matching, read the surrounding proof and the relevant definitions, and reason about the global structure before the next attempt.

**Budget:** at most 2 attempts per error signature and 6 (prove) / 8 (autoprove) per cycle; 2 consecutive attempts with no improvement on the same signature → **stuck** (see [cycle-engine.md § Stuck Definition](cycle-engine.md#stuck-definition)).

---

## Repair Strategies by Error Type

### type_mismatch

1. `convert _ using N` (N = unification depth 1-3)
2. Explicit type annotation: `(expr : TargetType)`
3. `refine` with placeholders
4. `rw` to align types
5. Intermediate `have` with correct type

```diff
-  exact h
+  convert continuous_of_measurable h using 2
+  simp
```

### unsolved_goals

1. Try automation: `simp?`, `apply?`, `exact?`, `grind`, `aesop`
2. By goal shape: equality → `rfl`, `ring`, `linarith`; ∀ → `intro`; ∃ → `use` or `refine ⟨_, _⟩`; → → `intro` then the conclusion
3. Search mathlib for a lemma
4. Break down: `constructor`, `cases`, `induction`

### unknown_ident

1. **Semantic search FIRST:** `lean_search {source: "leanfinder", query: "natural language description of what you want"}`
2. Check for ASCII vs Unicode naming (ℒp → MemLp, not Memℒp)
3. Search locally: `lean_search {source: "local", query: "ident"}`
4. Add namespace: `open Foo` or `open scoped Bar`
5. Add import: `import Mathlib.Foo.Bar`
6. Check for a typo

```diff
+import Mathlib.Topology.Instances.Real
 ...
-  continuous_real
+  Real.continuous
```

### synth_implicit / synth_instance

1. Supply the instance with actual evidence: `have : Instance := ⟨proof⟩` or a lemma that builds it (registers it; `haveI` only inlines). `have : Instance := inferInstance` re-runs the search that just failed — it only freezes an instance that is ALREADY synthesizable
2. Local instance whose value must stay visible (data, not a proof): `let inst : Instance := ...`
3. Make an existing instance visible: `import` the module that declares it or `open scoped Topology`
4. Reorder arguments (instances before regular params)

```diff
+  have : MeasurableSpace β := borel β   -- an actual value: needs `[TopologicalSpace β]`, and Borel must be the intended σ-algebra; `inferInstance` would just fail again
   apply theorem_needing_instance
```

### sorry_present

1. Search mathlib (many already exist)
2. Run the cascade
3. Compositional proof from mathlib lemmas
4. Break into subgoals — see [sorry-filling.md](sorry-filling.md)

### timeout / recursion_depth

1. Narrow `simp`: `simp only [lem1, lem2]` not `simp [*]`
2. Clear unused: `clear h1 h2`
3. Replace `decide` with `native_decide`
4. Provide instances explicitly
5. Revert then re-intro in a better order

---

## Common Pitfalls

### Pitfall 1: Type Coercion Assumptions (ENNReal vs ℝ)

`2` and `ENNReal.ofReal 2` are not interchangeable. Lp spaces expect `ENNReal` for `p`:

```lean
theorem bar (f : α → ℝ) : MemLp f 2 μ := by                  -- ❌ expected ENNReal
theorem bar (f : α → ℝ) : MemLp f (ENNReal.ofReal 2) μ := by -- ✓
```

**Catch it:** `lean_goal` for the expected type, `lean_nav {op: "hover"}` for the API signature; look for `ENNReal`, `ℝ≥0∞`, `ℝ≥0`. Measure theory APIs often expect `ENNReal` for measures and Lp norms, `ℝ≥0` for nonnegative reals, `ℝ` for signed reals. Don't assume automatic coercion.

### Pitfall 2: Field Access vs Function Call

```lean
have := hf.memLp                -- ❌ Invalid field 'memLp'
exact MemLp.ae_eq hf h.symm     -- ✓ function call, not field access
```

**Catch it:** "Invalid field 'X'" means it is a function, not a field. Hover on the identifier (`lean_nav {op: "hover"}`) and use `lean_search {source: "local"}` to find the right namespace (`MemLp.ae_eq`, not `hf.ae_eq`). Fields are data stored in a structure (`point.x`, `σ.carrier`); functions are operations (`MemLp.ae_eq`, `Continuous.comp`).

### Pitfall 3: Almost Everywhere Equality Direction

```lean
theorem qux (hf : MemLp f p μ) (h : g =ᵐ[μ] f) : MemLp g p μ := by
  exact MemLp.ae_eq hf h.symm  -- ✓ reverse with .symm (plain `h` is a type mismatch)
```

**Catch it:** a type mismatch mentioning `EventuallyEq` → compare directions with `lean_goal`, then `.symm`. Many relations have `.symm`: `=ᵐ[μ]`, `≈`, `↔`, `=`.

### Pitfall 4: ASCII vs Unicode Naming

Mathematical notation uses Unicode (ℒp); Lean APIs use ASCII (`MemLp`). "Unknown identifier" on a Unicode name → try the ASCII equivalent, or describe it to `lean_search {source: "leanfinder"}`. Common translations: ℒp → MemLp, ∞ → infinity or top (⊤), ≥0 → NNReal or ENNReal, ∫ → integral.

---

## Error Pattern Recognition

| Error | Likely cause | Fix strategy |
|-------|--------------|--------------|
| "Invalid field 'X'" | Function-call syntax on a type without that field | Hover to confirm it is a function; `x.foo` → `Foo.bar x`; local search for the namespace |
| "Type mismatch: expected ENNReal, got ℕ" (or ℝ) | Missing `ENNReal.ofReal` / `ENNReal.ofNat` | Hover the API; wrap literals (`2` → `ENNReal.ofReal 2`) and real variables |
| "Application type mismatch" with EventuallyEq | Wrong `=ᵐ[μ]` direction | `lean_goal` for the expected direction; add `.symm` |
| "Unknown identifier 'X'" | Unicode name, missing import, or wrong namespace | Leanfinder first; ASCII equivalent; local search; add the import; check for typos |
| "Failed to synthesize instance" | Missing type class instance in context | Supply evidence (`have : Instance := ⟨proof⟩`), `let` for data, import/`open scoped`, reorder parameters |

```diff
-  exact Memℒp.ae_eq
+  exact MemLp.ae_eq  -- ASCII, not Unicode
```

---

## Common Patterns

### Pattern 1: Type Mismatch with convert

```lean
theorem foo (h : Measurable f) : Continuous f := by
  convert continuous_of_measurable h using 2  -- was `exact h`: type mismatch
  simp
```

### Pattern 2: Missing Instance (supply it, don't re-search)

```lean
theorem bar : Property := by
  apply lemma  -- ❌ failed to synthesize instance MeasurableSpace α
```

Three different situations, three different fixes:
```lean
-- (a) the instance exists but is not visible: import the declaring module /
--     `open scoped ...`; no local binding needed.
-- (b) it is genuinely missing: supply a VALUE or PROOF (plain `have`/`let`
--     registers it). `:= inferInstance` here just re-runs the failed search.
theorem bar : Property := by
  have : MeasurableSpace α := borel α   -- requires `[TopologicalSpace α]` and that Borel is the intended σ-algebra; otherwise supply the intended structure or report the missing prerequisite
  apply lemma
-- (c) it already synthesizes and you only want to freeze it (performance,
--     stability): `have : MeasurableSpace α := inferInstance` is fine.
```

### Pattern 3: Unknown Identifier → Import

```lean
import Mathlib.Topology.Basic

theorem baz : Result := by
  exact Continuous.comp  -- was "unknown identifier" before the import
```

### Pattern 4: Unsolved Goal → Automation

```lean
theorem qux : a + b = b + a := by
  ring  -- ✓ (found by the cascade)
```

---

## Best Practices

### 1. Verify After Every Fix (Most Important!)

Check after EVERY 1-2 fixes, not after "a batch of fixes": one error at a time is faster than five at once, immediate feedback prevents cascading errors, and fixing one error can introduce another.

```
fix error 1  # → lean_diagnostics {path} → lake env lean FILE.lean
fix error 2  # → lean_diagnostics {path} → lake env lean FILE.lean
fix error 3  # → lean_diagnostics {path} → lake env lean FILE.lean
# milestone: lean_build only at checkpoint
```

Don't make many changes and then build once — errors from all of them mix together.

### 2. LeanFinder First, Always

Before writing ANY API call: `lean_search {source: "leanfinder"}` → `lean_search {source: "local"}` → `lean_nav {op: "hover"}` on the result → THEN write code. Prevents wrong API names, wrong signatures, wrong argument order.

### 3. Start with the Cascade

Always try the automation cascade (`lean_attempt {op: "tactics"}`) before writing a proof by hand.

### 4. Search Mathlib First

Many proofs already exist. Search before generating novel proofs.

### 5. Minimal Diffs

Change only 1-5 lines. Preserve existing proof structure and style.

### 6. Trust the Loop

Don't overthink individual attempts. Fast attempts verified by the compiler beat perfect attempts reasoned in the abstract.

---

## Troubleshooting

**Loop stuck on the same error:**
- Check whether the error is truly at the reported line (it may originate a few lines earlier)
- Inspect the goal and context again with `lean_goal` instead of guessing
- Follow [stuck triage](../../lean4-prove/SKILL.md#stuck-triage)

**Fixes keep missing context:** slow down — read the whole declaration and the definitions it uses, or fix manually and continue.

**Cascade too aggressive:** some proofs need structure, not automation. Write the structure (`constructor`, `cases`, intermediate `have`) by hand and run the cascade on the leaves.

---

## False Statement Handling

When the repair loop fails repeatedly:
- Consider that the statement may be false
- Try an explicit counterexample search on small domains
- If found, create a counterexample lemma instead of continuing repair
- See [stuck triage](../../lean4-prove/SKILL.md#stuck-triage) for the salvage workflow, or `/lean-disprove`

---

*Compiler-guided repair inspired by APOLLO (https://arxiv.org/abs/2505.05758)*
