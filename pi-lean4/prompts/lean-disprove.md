---
description: "Search for a counterexample to a Lean 4 statement and certify the refutation"
argument-hint: "<file:line | theorem>"
---
Read the `lean4-prove` skill first (its SKILL.md is listed among your available skills), then follow its section "Statement may be false". Do not try to prove the statement.

Target: ${@:-none given — ask me which statement to refute}

Work append-only: never rewrite the original declaration. Report REFUTED only when Lean has checked the counterexample theorem and its axioms are standard; otherwise WITNESS_UNCERTIFIED or INCONCLUSIVE.
