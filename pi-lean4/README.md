# pi-lean4

Lean 4 theorem proving for the [pi](https://pi.dev) coding agent: eight tools over one Lean language
server per session, proof-workflow skills, an unattended autoprove loop, and git guardrails.

- **Tools** — goals, diagnostics, tactic attempts on scratch copies, lemma search (local and four
  remote services), axiom and sorry checks, `lake build`, profiling and golf candidates.
- **Skills** — `lean4` (the essentials), `lean4-prove`, `lean4-repair`, `lean4-golf`,
  `lean4-formalize`, `lean4-review`, with ~7k lines of reference material.
- **Prompt templates** — `/lean-prove`, `/lean-repair`, `/lean-golf`, `/lean-review`,
  `/lean-checkpoint`, `/lean-formalize`, `/lean-disprove`.
- **`/lean`** — server status and control, `lake build`, and `/lean autoprove <file>`.
- **Hooks** — every `edit`/`write` of a `.lean` file comes back with a compact compile check;
  destructive git commands are blocked inside Lean projects.

It ports the functionality of [lean-lsp-mcp](https://github.com/oOo0oOo/lean-lsp-mcp) and
[lean4-skills](https://github.com/cameronfreer/lean4-skills) (both MIT) to a native pi extension:
TypeScript, no MCP, no Python.

## Install

```bash
pi install npm:@ocramz/pi-lean4
```

Requirements: Node 24, pi, a Lean 4 [Lake](https://github.com/leanprover/lean4/tree/master/src/lake)
project, and `lake` on `PATH` or in `~/.elan/bin` (install [elan](https://lean-lang.org/install/)).
[ripgrep](https://github.com/BurntSushi/ripgrep) is needed for local search (pi's own copy is used if
present). Linux and macOS.

From a checkout: `pi -e ./pi-lean4` loads the extension with its skills and templates.

## Tools

| Tool | What it answers |
|------|-----------------|
| `lean_goal {path, line, column?, kind?}` | the goals before/after a line, or at a point; `kind: "term"` for the expected type |
| `lean_diagnostics {path, startLine?, endLine?, declaration?, severity?, timeout?}` | errors, warnings, sorries (tagged), with hints; partial results while elaborating |
| `lean_attempt {op: "tactics", path, line, snippets}` / `{op: "code", code}` | try candidates on a scratch copy — "closes the goal", "goals remain", "fails"; or check standalone code |
| `lean_search {source, query}` | `local` (project, packages, Lean core), `leansearch`, `leanfinder`, `loogle`, `premises` |
| `lean_nav {op, path, …}` | hover, completions, definition, references, code actions (reported, not applied), outline |
| `lean_verify {op: "axioms" \| "sorries", …}` | axiom dependencies classified standard/incomplete/native/custom; every `sorry` lexically |
| `lean_build {clean?, fetchCache?, force?}` | `lake build`, skipped when nothing changed since the last success |
| `lean_analyze {op: "profile" \| "hypotheses" \| "golf", …}` | per-line timing, unneeded hypotheses (report only), golf candidates |

Positions are 1-indexed lines and character columns. Failures (no project, no `lake`, bad parameters,
rate limits) are error results; Lean's verdicts are normal results. The full reference the model
reads is [skills/lean4/references/tools.md](skills/lean4/references/tools.md).

## The Lean server

- **One per session, started lazily.** Nothing runs until a tool needs Lean. A call about a file in
  another Lake project moves the server there. Concurrent first calls share one start.
- **Stopped with the session.** `session_shutdown` stops it for every reason (quit, `/new`,
  `/resume`, `/fork`, `/reload`): LSP `shutdown`, then the process group, then any worker that runs in
  a group of its own (Lean's workers do). If pi exits without that event, a process-exit hook kills
  what is left.
- **Compiles only what a question needs.** Files open with `dependencyBuildMode: "never"`; text is
  re-sent only when the bytes on disk changed; the "elaboration done" barrier is cached per version.
  When a file's imports are stale — Lean says so, or an in-project import changed on disk, which Lean
  does *not* notice by itself — the file is reopened once with `"once"`, which rebuilds exactly its
  imports. `lake build` runs only through `lean_build`, and not even then if nothing changed.
- **Throwaway text never touches disk.** Tactic attempts, standalone code and axiom checks use
  scratch documents that exist only in the server.
- **Crashes are noticed.** Lean says nothing when a file worker dies; the client watches the process
  tree, reopens the file, and fails a waiting call promptly instead of at its timeout. More than three
  server crashes a minute stops the restarts.

`/lean status` shows where `lake` and `rg` were found, the setup check below, the project, the
server and its open files, the build state, and the configuration. `/lean restart` / `/lean stop`
replace or stop the server.

## Setup check

When a session starts inside a Lake project (or above one), pi-lean4 checks the machine — file
lookups only, nothing spawned, no network — and reports each problem with what it breaks and the
commands that fix it:

| Finding | Severity |
|---------|----------|
| `lake` not found, or `PI_LEAN_LAKE` / `lean4.lake` points at nothing | error |
| `lake` found in `~/.elan/bin` but not on `PATH` (bash `lake …` commands will fail) | warning |
| the project's pinned toolchain not installed (downloaded on first use) — an error in offline mode | warning |
| Lean older than 4.24; `lake` not managed by elan (pin not enforced) | warning |
| dependencies unresolved or not downloaded; Mathlib's build files missing (would compile Mathlib from source) | warning (error offline) |
| ripgrep not found (local search only) | warning |
| `.lean` files but no Lake project | warning |
| `.pi/settings.json` lean4 settings ignored in an untrusted project | info |

The human sees the report on startup and `/reload` (a notification, or stderr in print mode) and a
footer badge until it is fixed. The model is told before its first turn — what is broken, the fix, to
ask before running a fix itself, and not to retry — and told again when the set of problems changes,
including when they are resolved. A tool that fails for one of these reasons repeats the same fix in
its error. Nothing needs a restart to pick up a fix, except adding a directory to `PATH` for bash.

## Auto-check

After `edit` or `write` on a `.lean` file of the project the server is bound to, the result gets a
line such as `[lean auto-check] Foo.lean: compiles — no errors, no sorries.` or the error count with
the first errors. It waits at most `autoCheckTimeoutMs` and reports "still elaborating" past that.
Mode `running` (default) never starts a server for this; `always` does; `off` disables it.

## /lean autoprove

`/lean autoprove <file> [--max-cycles=20] [--max-stuck=3] [--max-runtime=120m]` runs the
lean4-prove skill's cycle without asking, one cycle per turn. After every turn the extension itself
measures the file (sorries and errors) and continues, or stops on: completion, the cycle budget,
too many cycles in a row without progress, the running-time budget, Esc or a new prompt, or a failed
model request. State is saved in the session: after `/resume` or `/reload` a loop comes back
*paused*; `/lean autoprove resume` continues it, `/lean stop-autoprove` ends it.

Headless: `pi -p "/lean autoprove Foo.lean"` runs to the end and exits.

## Git guardrails

Inside a Lean project (an ancestor has `lean-toolchain` or a lakefile), bash commands that would
destroy uncommitted proof work are blocked: `git reset --hard`, `git clean -f`, whole-worktree
`checkout`/`restore`, forced `checkout`/`switch`, and force/mirror/delete pushes. The command is
parsed like a shell would (quotes, `&&`/`;`/`|`, `$(…)`, `bash -c`, heredocs), so
`git commit -m "reset --hard"` passes and `cd x && git reset --hard` does not. There is no bypass
token; the human can run the command or use `/lean guardrails off`.

## Remote search and privacy

`lean_search` sources other than `local` send the query — for `premises`, the goal text — to
third-party services: [leansearch.net](https://leansearch.net), Lean Finder, [loogle](https://loogle.lean-lang.org)
and leanpremise.net. They are rate-limited client-side as lean-lsp-mcp does (90, 10, 3 and 6 per
30 s). `--lean-offline` or `PI_LEAN_OFFLINE=1` turns them off, along with Mathlib cache downloads and
elan toolchain downloads. (Lake may still fetch missing package dependencies on its own.)

## Configuration

First match wins: the `--lean-offline` flag, environment variables, then the `lean4` key of the
project's `.pi/settings.json` (read only for trusted projects), then defaults.

| Setting | Environment | Default |
|---------|-------------|---------|
| `offline` | `PI_LEAN_OFFLINE` | `false` |
| `autoCheck` | `PI_LEAN_AUTOCHECK` | `running` (`off`, `always`) |
| `autoCheckTimeoutMs` | `PI_LEAN_AUTOCHECK_TIMEOUT_MS` | `15000` |
| `guardrails` | `PI_LEAN_GUARDRAILS` | `true` |
| `maxOpenFiles` | `PI_LEAN_MAX_OPEN_FILES` | `4` (each is a Lean worker; with Mathlib, GBs) |
| `scratchSlots` | `PI_LEAN_SCRATCH_SLOTS` | `1` |
| `maxOutputChars` | `PI_LEAN_MAX_OUTPUT_CHARS` | `6000` per field (`0` = unbounded) |
| `requestTimeoutMs` / `elaborationTimeoutMs` / `startTimeoutMs` / `buildTimeoutMs` | `PI_LEAN_*_TIMEOUT_MS` | 2 min / 10 min / 2 min / 1 h |
| `lake`, `rg` | `PI_LEAN_LAKE`, `PI_LEAN_RG` | found on `PATH`, `~/.elan/bin`, pi's `bin/`, `~/.local/bin` |
| `autoprove.maxCycles` / `maxStuckCycles` / `maxRuntimeMinutes` | `PI_LEAN_AUTOPROVE_MAX_CYCLES` / `_MAX_STUCK` / `_MAX_RUNTIME_MINUTES` | 20 / 3 / 120 |
| `search.leansearchUrl` / `loogleUrl` / `leanfinderUrl` / `premiseUrl` | `PI_LEAN_LEANSEARCH_URL` / … | the public services (a custom URL is not rate-limited) |

```json
{ "lean4": { "autoCheck": "always", "maxOpenFiles": 2, "offline": true } }
```

## Development

| Tier | Command | Needs | Covers |
|------|---------|-------|--------|
| unit | `npm test` | node | LSP framing/connection, positions, the server against a scripted fake LSP (process groups, stale imports, crashes), every op's text processing, search parsers with a stubbed `fetch`, guardrails, the autoprove state machine, the skills and templates |
| types | `npm run typecheck` | — | everything against pi's real declarations |
| interactive | `npm run test:tui` | pi, `script` | what the model is told (tools, guidelines, skills — snapshot: `PI_UPDATE_PROMPT=1` to re-record), `/lean`, templates, guardrails, behaviour with no Lean |
| Lean | `npm run test:lean` | pi, the pinned toolchain | Lean's behaviour the design relies on (`contract.test.ts`), every op on a real server, the lifecycle through `pi -p` with a scripted model, `/lean autoprove` headless, and one paid live case |
| container | `npm run test:container` | podman | the unit suites and the extension in the pinned distroless image, with no Lean |

The Lean tier runs on the host. From the repository root: `make lean-install` (elan, the toolchain
pinned in `shared/versions.env`, ripgrep — into `$HOME`, no sudo), then `make test-lean PKG=pi-lean4`.
Its live case needs `OPENROUTER_API_KEY` and fails without it.

Layout: `src/` is plain TypeScript with no pi imports (the LSP client in `src/lsp/`, the server and
runtime in `src/lean/`, one module per op in `src/ops/`, the hooks' logic in `src/hooks/`);
`extensions/` is the pi wiring; `skills/` and `prompts/` ship as package resources.

## Credits

The tool behaviour, search backends and verification logic follow
[lean-lsp-mcp](https://github.com/oOo0oOo/lean-lsp-mcp) (© 2025 Oliver Dressler); the skills,
references, guardrail rules and autoprove budgets follow
[lean4-skills](https://github.com/cameronfreer/lean4-skills) (© 2025 Lean 4 Theorem Proving Skill
Contributors). Both MIT; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details and a map of what derives from
what. If you use the Lean API search services in research, cite their respective authors.
