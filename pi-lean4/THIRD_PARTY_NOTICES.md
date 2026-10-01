# Third-party notices

pi-lean4 is MIT-licensed (see LICENSE). Parts of it are adapted from two MIT-licensed projects,
whose copyright and permission notices are reproduced below as their licences require.

| Project | Source | Pinned at |
|---|---|---|
| lean-lsp-mcp | https://github.com/oOo0oOo/lean-lsp-mcp | `f00f625810d183dbb597a3677d2d5a83b084f761` (v0.31.0) |
| lean4-skills | https://github.com/cameronfreer/lean4-skills | `b6243b85b9b0a0ddff5bb6773889044daf687f8e` (plugin v4.11.3) |

## What derives from what

Every skill and reference file names its origin in an HTML comment at its top (after the
frontmatter for SKILL.md). Kinds: **verbatim** (unchanged apart from that comment), **adapted**
(tool names, links and sections rewritten for pi), **condensed** (shortened, same headings),
**derived** (new text or code following the upstream design).

| File | Kind | Upstream |
|---|---|---|
| skills/lean4/references/axiom-elimination.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/axiom-elimination.md |
| skills/lean4/references/compilation-errors.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/compilation-errors.md |
| skills/lean4/references/compiler-guided-repair.md | condensed | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/compiler-guided-repair.md |
| skills/lean4/references/cycle-engine.md | condensed | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/cycle-engine.md |
| skills/lean4/references/grind-tactic.md | verbatim | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/grind-tactic.md |
| skills/lean4/references/instance-pollution.md | verbatim | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/instance-pollution.md |
| skills/lean4/references/lean-phrasebook.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/lean-phrasebook.md |
| skills/lean4/references/mathlib-guide.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/mathlib-guide.md |
| skills/lean4/references/mathlib-review-taxonomy.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/mathlib-review-taxonomy.md |
| skills/lean4/references/mathlib-style.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/mathlib-style.md |
| skills/lean4/references/proof-golfing-patterns.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/proof-golfing-patterns.md |
| skills/lean4/references/proof-golfing.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/proof-golfing.md |
| skills/lean4/references/proof-simplification.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/proof-simplification.md |
| skills/lean4/references/proof-templates.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/proof-templates.md |
| skills/lean4/references/simp-reference.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/simp-reference.md |
| skills/lean4/references/sorry-filling.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/sorry-filling.md |
| skills/lean4/references/tactic-patterns.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/tactic-patterns.md |
| skills/lean4/references/tactics-reference.md | verbatim | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/references/tactics-reference.md |
| skills/lean4/references/tools.md | derived | oOo0oOo/lean-lsp-mcp@f00f625 src/lean_lsp_mcp/instructions.py and docs/tools.md |
| skills/lean4-formalize/SKILL.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/commands/draft.md, formalize.md, autoformalize.md and skills/lean4/references/cycle-engine.md |
| skills/lean4-golf/SKILL.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/commands/golf.md, commands/refactor.md and agents/proof-golfer.md |
| skills/lean4-prove/SKILL.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/commands/prove.md, autoprove.md, disprove.md, agents/sorry-filler-deep.md and skills/lean4/references/cycle-engine.md, sorry-filling.md |
| skills/lean4-repair/SKILL.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/agents/proof-repair.md, agents/axiom-eliminator.md and skills/lean4/references/compiler-guided-repair.md, cycle-engine.md |
| skills/lean4-review/SKILL.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/commands/review.md and commands/checkpoint.md |
| skills/lean4/SKILL.md | adapted | cameronfreer/lean4-skills@b6243b85 plugins/lean4/skills/lean4/SKILL.md |
| src/lsp/*, src/lean/server.ts, src/lean/runtime.ts | derived | lean-lsp-mcp client_utils.py and the leanclient behaviour it relies on (file sync, barrier, stale-import reopen, scratch documents) |
| src/ops/diagnostics.ts | adapted | lean-lsp-mcp diagnostic_utils.py, tools/diagnostics.py |
| src/ops/goals.ts, src/ops/nav.ts | adapted | lean-lsp-mcp tools/goals.py, tools/navigation.py |
| src/ops/attempt.ts | adapted | lean-lsp-mcp attempt_utils.py |
| src/ops/verify.ts | adapted | lean-lsp-mcp verify.py |
| src/ops/build.ts | adapted | lean-lsp-mcp build_utils.py |
| src/ops/search/* | adapted | lean-lsp-mcp search_utils.py, tools/search.py, loogle.py, config.py (endpoints, rate limits) |
| src/ops/analyze/profile.ts, src/ops/analyze/hypotheses.ts | adapted | lean-lsp-mcp profile_utils.py, minimal_hypotheses.py, tools/analysis.py |
| src/ops/decls.ts, src/ops/sorries.ts | derived | lean4-skills lib/scripts/sorry_analyzer.py |
| src/ops/analyze/golf.ts | adapted | lean4-skills lib/scripts/find_golfable.py |
| src/hooks/guardrails.ts | derived | lean4-skills hooks/guardrails.sh (rule set) |
| src/hooks/autoprove.ts | derived | lean4-skills commands/autoprove.md (budgets and stop conditions) |

## lean-lsp-mcp

```
MIT License

Copyright (c) 2025 Oliver Dressler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## lean4-skills

```
MIT License

Copyright (c) 2025 Lean 4 Theorem Proving Skill Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
