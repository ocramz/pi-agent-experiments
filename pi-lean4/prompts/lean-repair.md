---
description: "Fix Lean 4 code that does not compile, with minimal verified diffs (no sorry filling)"
argument-hint: "[file[:line]] [instructions]"
---
Read the `lean4-repair` skill first (its SKILL.md is listed among your available skills), then follow its repair loop.

Target: ${@:-the .lean files with errors among those changed since the last commit}

Fix errors one at a time with the smallest verified diff. Do not fill intentional sorries, do not change any statement, and stop at the skill's budgets with a report.
