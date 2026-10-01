---
description: "Read-only review of Lean 4 proofs: sorries, axioms, style, Mathlib readiness"
argument-hint: "[file[:line]] [--stuck] [--mathlib] [--scope=sorry|file|changed|project]"
---
Read the `lean4-review` skill first (its SKILL.md is listed among your available skills), then follow its review workflow.

Target and options: ${@:-scope=changed, the .lean files changed since the last commit}

Read-only: do not edit files, stage or commit. Report findings in the skill's format.
