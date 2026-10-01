---
description: "Golf, simplify or refactor compiling Lean 4 proofs without changing statements"
argument-hint: "[file[:line]] [--dry-run] [--search=off|quick|full] [--refactor]"
---
Read the `lean4-golf` skill first (its SKILL.md is listed among your available skills), then follow its workflow.

Target and options: ${@:-the .lean files changed since the last commit}

The file must compile before you start. Verify every change and revert it on any regression. Do not commit.
