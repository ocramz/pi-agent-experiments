---
description: "Guided Lean 4 proving: fill sorries cycle by cycle, asking before each cycle and each commit"
argument-hint: "[file[:line] | theorem] [--deep=never|ask|stuck] [instructions]"
---
Read the `lean4-prove` skill first (its SKILL.md is listed among your available skills), then follow its guided mode.

Target and options: ${@:-none given — use every sorry in .lean files changed since the last commit, and ask me if that is unclear}

Guided mode: show the plan before starting, ask before each new cycle and before every commit. For unattended proving I will use /lean autoprove instead.
