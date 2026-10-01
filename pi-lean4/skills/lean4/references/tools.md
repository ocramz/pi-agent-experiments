# The lean_* tools

Eight tools over one Lean language server per pi session. The server starts on the first call that
needs it and stops when the session ends; a call about another Lake project moves it there.

**Conventions.**
- `path` is a `.lean` file, absolute or relative to the working directory.
- Positions are **1-indexed**: `line` as shown by `read`, `column` counted in characters (𝔽 is one).
- A **failed call** (bad parameters, no Lake project, no `lake`, rate limit, offline refusal, a
  crashed worker) comes back as an error result. An **answer** — errors in your file, sorries, a
  file still elaborating, an empty search — is a normal result. Read the text; don't retry blindly.
- Only what changed since the last question is re-elaborated. Asking again about an unchanged file
  is free.

## lean_goal — the proof state

`lean_goal {path, line}` shows the goals **before** the line's first token and **after** its last:
exactly what that line's tactic does. `lean_goal {path, line, column}` shows the goals at one point.
`kind: "term"` gives the expected type of the term being elaborated there instead.

- "no goals: the proof is complete at this point" — that branch is done.
- "no tactic state here" — the position is not inside a `by` block.
- Use it constantly: before writing a step, and after any step whose effect you are unsure of.

## lean_diagnostics — what Lean says about a file

`lean_diagnostics {path}`; narrow with `startLine`/`endLine` or `declaration`, filter with
`severity` (`error`, `warning`, `info`, `hint`). Each message is tagged:

| Tag | Meaning |
|-----|---------|
| `[sorry]` | the declaration is unfinished |
| `[suggestion]` | a "Try this:" from `exact?`, `apply?`, `simp?`… — see `lean_nav {op: "code_actions"}` |
| `[linter]` | style noise (unused variables, linters); not a failure |
| (none) | an ordinary error/warning/info |

Some errors carry a `hint:` line with the usual remedy. "Imports failed to build" lists dependency
files with errors — fix those first.

**Partial results.** If elaboration does not finish within `timeout` seconds (default 600) you get
the messages so far and the line ranges still elaborating. Call again to keep waiting.

**The auto-check.** When a Lean server is already running for the project, results of `edit` and
`write` on a `.lean` file end with a `[lean auto-check]` line: "compiles — no errors, no sorries",
or the error count with the first few errors, or "still elaborating". It is bounded (~15s). You do not
need `lean_diagnostics` after every edit — use it when the auto-check is missing, incomplete, or you
need every message.

**Stale imports** are handled for you: if a file's imports changed or were never built, the server
rebuilds exactly those imports once and the result says so.

## lean_attempt — try without editing

`lean_attempt {op: "tactics", path, line, snippets: [...]}` — each snippet replaces the tactic at
`line` (from `column`, default the line's first non-space character, to the end of the line; a
snippet of *n* lines replaces *n* lines) in a scratch copy of the file. Per candidate you get:

- `closes the goal` — no errors and no goals left at the end of the snippet;
- `goals remain` — no errors, with the goals still open (shown);
- `fails` — with the errors on the snippet's lines and any *new* error elsewhere;
- `no tactic state` — the position is not in a proof.

Give 2–4 candidates per call: direct (`exact foo`), tactic (`simp [h]`, `omega`), automation
(`aesop`, `grind`), and one built from a search hit. Then write the winner with `edit`.

`lean_attempt {op: "code", code}` elaborates standalone code (with its own `import`s) in the current
project: `#check`, `#eval`, `#print axioms`, a test lemma. This replaces scratch files — never create
throwaway `.lean` files in the repository.

## lean_search — find the lemma

| Source | Ask it | Example query |
|--------|--------|---------------|
| `local` | does this name exist? (project, `.lake/packages` incl. Mathlib, Lean core) | `Nat.add_comm`, `sum_range` |
| `leansearch` | a statement in words | `"sum of two even numbers is even"` |
| `leanfinder` | meaning, or a goal pasted as text | `"I have h : n < m and need n + 1 < m + 1"` |
| `loogle` | a type shape or constant | `Real.sin`, `(?a → ?b) → List ?a → List ?b`, `\|- _ < _ → _ + 1 < _ + 1` |
| `premises` | lemmas for the goal at `path:line:column` | (no query) |

**Decision tree.**
1. You have (or guess) a name → `local` first. It is offline, fast and unlimited; an empty result
   while the server is running is strong evidence the name does not exist.
2. You know the statement in words → `leansearch` or `leanfinder`.
3. You know the shape (`_ * (_ ^ _)`, `?f ∘ ?g`) → `loogle`.
4. You are stuck on a goal → `premises` at the goal, then try the names in `simp only [...]`,
   `grind [...]` or `aesop` with `lean_attempt`.
5. Always confirm a name from a remote source with `local` (or `lean_nav {op: "hover"}`) before
   relying on it: remote indexes can be for another Mathlib version.

Remote sources send your query (premises: the goal) to free public services and are rate-limited
per service. If a call reports a rate limit, **switch source or use `local`** — never retry in a
loop. In offline mode (`--lean-offline` / `PI_LEAN_OFFLINE=1`) only `local` is available; fall back to
`rg` over `.lake/packages/mathlib/Mathlib` for text search.

## lean_nav — navigate

| op | needs | gives |
|----|-------|-------|
| `hover` | line+column or `symbol` | the type and docs of a name |
| `completions` | line+column | what Lean would complete there |
| `definition` | line+column or `symbol` | where it is defined, with its source |
| `references` | line+column or `symbol` | every use (indexed files only) |
| `code_actions` | line | Lean's suggested edits on that line, e.g. the result of `exact?` — **not applied** |
| `outline` | path | imports and declarations with signatures and line ranges |

To use a "Try this" suggestion: `lean_nav {op: "code_actions", path, line}`, then apply the edit with
`edit`, then check.

## lean_verify — is it really done?

- `lean_verify {op: "axioms", path, name}` — what a theorem depends on (omit `name` for every theorem
  in the file). `propext`, `Classical.choice`, `Quot.sound` are **standard**; `sorryAx` means
  **incomplete** (a sorry in it or in something it uses); `Lean.ofReduceBool`/`native_decide` means it
  trusts compiled code; anything else is a **custom axiom**. Also lists constructs in the file that can
  change what a proof means (`unsafe`, `@[implemented_by]`, local instances…).
- `lean_verify {op: "sorries", path}` — every `sorry` in a file or directory (default: the project),
  found without compiling, with its declaration.

## lean_build — the project gate

`lean_build {}` runs `lake build` — skipped when nothing changed since the last successful one.
`clean: true` runs `lake clean` first; `fetchCache: true` runs `lake exe cache get` (Mathlib's
prebuilt files; needs the network). The server is stopped for the build and restarts on the next
call. You rarely need it: after changing imports or adding a module, when diagnostics report imports
that failed to build, and at checkpoints. For one file, `lake env lean <file>` (bash, from the project
root) is the file gate.

## lean_analyze — improve proofs that compile

- `lean_analyze {op: "golf", path}` — places a proof could likely be shorter, each with advice. Only
  candidates: try each with `lean_attempt`.
- `lean_analyze {op: "profile", path, line}` — compiles the theorem starting at `line` with
  `lean --profile` and lists its slowest lines. Slow; use on proofs that are actually slow.
- `lean_analyze {op: "hypotheses", path, name}` — drops each explicit `(h : T)` hypothesis in turn and
  reports which ones the proof needs. Report only: removing one changes the statement.

## /lean (for the human)

`/lean status`, `/lean restart`, `/lean stop`, `/lean build`, `/lean autoprove <file>` (an unattended
proving loop with budgets), `/lean stop-autoprove`, `/lean guardrails on|off`.
