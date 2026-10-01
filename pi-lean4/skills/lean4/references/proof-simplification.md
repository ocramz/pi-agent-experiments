# Proof Simplification

Guide for simplifying Lean 4 proofs at the *strategy* level: finding fundamentally better proof approaches, leveraging mathlib, and extracting reusable helpers. Complements [proof-refactoring.md](https://github.com/cameronfreer/lean4-skills/blob/b6243b85b9b0a0ddff5bb6773889044daf687f8e/plugins/lean4/skills/lean4/references/proof-refactoring.md) (structural extraction) and [proof-golfing.md](proof-golfing.md) (tactic-level optimization).

## Quick Decision Tree

```
Proof seems too long or complex
├─ Is it doing something "basic" in 20+ lines?
│   ├─ Search mathlib — the lemma probably exists (→ Replace with Mathlib)
│   │   └─ Not found → State in mathlib-ready generality (→ Missing Lemmas)
│   └─ Still hard → Definition might be fighting you (→ Definition Problems)
├─ Same pattern appears 2+ times?
│   └─ Extract helper in maximum generality (→ Helper Extraction)
├─ Proof has a complex case split?
│   └─ Search for a congr/EqOn/EventuallyEq approach (→ Congr Lemmas)
├─ Proof manually threads through a definition?
│   └─ Search for a lemma about the definition (→ Replace with Mathlib)
└─ Proof is inherently complex, just long?
    └─ Restructure instead (proof-refactoring.md, linked above)
```

## Replace with Mathlib Lemmas

The single highest-impact simplification. For search protocol details, see [mathlib-guide.md](mathlib-guide.md) and [tools.md](tools.md).

### Common Patterns Worth Searching

| Proof Pattern | Mathlib Lemmas to Search |
|---------------|-----------|
| Continuity of piecewise function | `ContinuousOn.if`, `ContinuousOn.union_of_isClosed`, `LocallyFinite.continuousOn_iUnion` (→ [Congr Lemmas](#congr-lemmas)) |
| Property of a function that equals another on a set | `ContinuousOn.congr`, `HasDerivWithinAt.congr_of_eventuallyEq`, `Measurable.congr` (→ [Congr Lemmas](#congr-lemmas)) |
| Floor/ceil equals specific value | `Nat.floor_eq_on_Ico`, `Int.floor_eq_iff` |
| Lipschitz/bound transfer | `LipschitzWith.dist_le_mul`, `LipschitzOnWith` |
| Filter membership | `Ioo_mem_nhdsGT`, `Ico_mem_nhdsGE`, `filter_upwards` |
| Set equality on interval | `Set.EqOn`, `Set.EqOn.eventuallyEq_nhdsWithin` (→ [Congr Lemmas](#congr-lemmas)) |
| Finset induction over image/sum/card | `Finset.card_image_of_injective`, `Finset.sum_image`, `Finset.prod_image` (→ [Finset Patterns](#finset-patterns)) |
| Two morphisms equal by manual pointwise unfolding | `MonoidHom.ext`, `RingHom.ext`, `LinearMap.ext`, `AlgHom.ext` (→ [Ext Lemmas](#ext-lemmas)) |
| Monotonicity / sup-inf inequalities | `Monotone.comp`, `StrictMono.comp`, `sup_le_iff`, `le_inf_iff` (→ [Order/Lattice Patterns](#orderlattice-patterns)) |

## Congr Lemmas

Replace case splits where a `congr`-style lemma would be cleaner.

### Pattern: Transfer via `Set.EqOn`

**Before:** Prove continuity by case-splitting on endpoints and interior:
```lean
intro t ht
rcases eq_or_lt_of_le ht.2 with rfl | h_lt
· -- Right endpoint: [10 lines]
· rcases eq_or_lt_of_le ht.1 with rfl | h_gt
  · -- Left endpoint: [8 lines]
  · -- Interior: [5 lines]
```

**After:** Show function equals a known-continuous function on the set, transfer:
```lean
suffices h_eq : Set.EqOn f g s from (hg_cont.congr h_eq)
intro t ht
-- Unified proof (often much shorter)
```

`ContinuousOn.congr` takes `ContinuousOn f s` and `EqOn g f s` to give `ContinuousOn g s`. Direction matters: `EqOn` goes from the *new* function to the *known-continuous* function.

### Pattern: Transfer via `EventuallyEq`

When manually differentiating a complex function by unfolding and assembling, show it agrees with a known-differentiable function eventually instead:
```lean
have h_eq : f =ᶠ[nhdsWithin t s] g := by
  filter_upwards [some_neighborhood_lemma] with x hx
  exact function_agrees_on_interval x hx
exact h_deriv_g.congr_of_eventuallyEq h_eq h_val
```

### When Congr Lemmas Help

- Function is defined piecewise but equals something simpler on each piece
- You need continuity/differentiability/measurability of a complex function
- The complex function agrees with a simple one on the relevant set
- Case splits are about matching definitions, not about mathematical content

## Finset Patterns

Replace Finset induction with direct combinatorial lemmas when the inductive step is mostly `simp` with `insert`/`erase`/`mem_image`.

**Before:** Manual induction over a Finset with mechanical insert/erase bookkeeping:
```lean
apply Finset.induction_on s
· simp
· intro a s ha ih
  rw [Finset.image_insert, Finset.card_insert_of_not_mem]
  simp only [Finset.mem_image, not_exists] at ha ⊢
  constructor
  · intro h; exact absurd (hinj.eq_iff.mp h) (ha _ rfl)
  · rw [ih]
  -- ... more insert/erase/mem_image reasoning
```

**After:**
```lean
exact Finset.card_image_of_injective s hinj
-- or: Finset.sum_image fun x _ y _ h ↦ hinj h
-- or: Finset.prod_image ...
```

Mathlib has pre-packaged lemmas for `card`, `sum`, `prod`, `sup`, and `inf` over `Finset.image`. If the induction step is mechanical bookkeeping, the lemma almost certainly exists.

## Ext Lemmas

Replace manual pointwise unfolding of morphism equality with `ext` lemmas. Applies when proofs coerce to bare functions and unfold with `map_add`/`map_mul`/`map_one` chains.

**Before:** Manual pointwise unfolding to show two ring homomorphisms are equal:
```lean
show (f.comp g : R →+* S) = h
apply DFunLike.ext
intro x
simp only [RingHom.comp_apply]
-- unfold (f ∘ g)(x) and h(x), then rewrite with map_* lemmas:
rw [map_add, map_mul, map_one]
-- ... repeat for each generator / case
```

**After:**
```lean
ext x <;> simp
-- or when simp needs guidance:
-- exact RingHom.ext fun x ↦ by simp [h_comm]
```

`MonoidHom.ext`, `RingHom.ext`, `LinearMap.ext`, and `AlgHom.ext` reduce morphism equality to pointwise equality with the correct coercion context. Combined with `simp`, this eliminates manual `DFunLike.ext` + `map_*` chains.

## Order/Lattice Patterns

Replace manual monotonicity threading and `sup`/`inf` splitting with compositional lemmas.

### Pattern: Monotone composition

**Before:** Manual monotonicity through a multi-layer composition:
```lean
intro a b hab
apply hg
apply hf
exact hab
-- or for deeper compositions:
intro a b hab
have h1 := hf hab
have h2 := hg h1
have h3 := hk h2
exact h3
```

**After:**
```lean
exact hg.comp hf
-- deeper: exact (hk.comp hg).comp hf
```

`Monotone.comp`, `StrictMono.comp`, `Antitone.comp` handle arbitrary composition depth.

### Pattern: Lattice sup/inf splitting

**Before:** Manual splitting of a `sup_le` or `le_inf` goal:
```lean
refine sup_le ?_ ?_
· -- show a ≤ c
  calc a ≤ b := h₁
       _ ≤ c := h₂
· -- show a' ≤ c
  calc a' ≤ b' := h₃
        _ ≤ c  := h₄
```

**After:**
```lean
exact sup_le_iff.mpr ⟨h₁.trans h₂, h₃.trans h₄⟩
-- or: exact le_inf h_left h_right
-- these compose: sup_le_sup h₁ h₂
```

`sup_le_iff`, `le_inf_iff`, `sup_le_sup`, and `le_inf` handle lattice plumbing.

## Helper Extraction

Extract repeated proof patterns (same `rw`/`simp` chain 2+ times, same `nlinarith` structure, same definitional unfolding) as standalone lemmas.

### Extraction Protocol

1. **Find the common core** — what mathematical fact is being proved each time?
2. **State it as a standalone lemma** with the most general hypotheses
3. **Name it after what it proves**, not where it's used
4. **Place it before first use**

### Generalization Checklist

When extracting, ask:
- **Weaker hypotheses?** Can `=` become `≤`? Can `Fin n` become `ℕ`?
- **Fewer assumptions?** Does the proof actually use all hypotheses?
- **More general types?** Can `ℝ` become `[LinearOrderedField α]`?
- **Mathlib-ready?** Would this be useful in mathlib? If so, state it in mathlib conventions (see [mathlib-style.md](mathlib-style.md)).

## Missing Lemmas

Sometimes the right lemma doesn't exist in mathlib. Signs: 20+ lines to prove something "obvious", same proof repeated across projects, only basic library infrastructure needed, natural place in an existing module.

What to do:
1. State it in maximum generality (most general typeclasses)
2. Follow mathlib naming conventions (see [mathlib-style.md](mathlib-style.md))
3. Use a `private` version locally for now
4. Note it in the refactoring report for potential contribution

## Definition Problems

Sometimes the proof is hard because the definition is fighting you. Signs: every proof starts with `unfold foo; simp`, same definitional unfolding in every lemma, arithmetic computations dominate due to discretization.

What to do:
1. **Build the API** — prove key properties as standalone lemmas
2. **Consider alternative definitions** — would an equivalent definition be easier to work with?
3. **Use `simp` lemmas** — make key equalities available to `simp` so proofs don't need manual unfolding

## File-Level Audit Checklist

When analyzing a whole file:

1. **Repeated tactic sequences** — same `rw`/`simp` chain 2+ times → extract helper
2. **Proof lengths** — >30 lines for "basic" facts → search mathlib; >60 lines → strong candidate
3. **Hand-rolled basics** — continuity proofs not using `fun_prop`, derivatives not using `HasDerivAt` chains, arithmetic not using `omega`/`positivity`/`norm_num`
4. **Overly specific hypotheses** — can `=` become `≤`? Can `[NormedSpace ℝ E]` become `[Module ℝ E]`?
5. **API coverage** — is every proof unfolding a definition directly? Should there be intermediate API lemmas?

## See Also

- [proof-refactoring.md](https://github.com/cameronfreer/lean4-skills/blob/b6243b85b9b0a0ddff5bb6773889044daf687f8e/plugins/lean4/skills/lean4/references/proof-refactoring.md) — Structural refactoring (breaking proofs into helpers)
- [proof-golfing.md](proof-golfing.md) — Tactic-level optimization
- [mathlib-guide.md](mathlib-guide.md) — How to search mathlib
- [mathlib-style.md](mathlib-style.md) — Naming conventions for potential mathlib contributions
