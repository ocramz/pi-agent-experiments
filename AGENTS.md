## What this is

A monorepo of extensions for the [Pi coding agent](https://pi.dev): one directory per extension, plus `shared/` holding the build and test tooling they have in common.

## Commands

All test targets run in the dev container (`make dev` starts it detached; `make shell` gets a shell
in it). `.env` with `OPENROUTER_API_KEY` is a prerequisite for every target.

```bash
make check          # test-image, test, typecheck, test-tui, test-container — in that order
make test           # host unit suites (node --test)
make typecheck      # tsc against pi's real declarations
make test-tui       # interactive suites: pi's real TUI, driven in a pty
make test-container # container suites, including the live model-driven tier
make test-image     # the pinned image's git capability probe — once for the repo, not per package
```

Narrow any target except `test-image` to one package with `PKG=`:

```bash
make test PKG=pi-issue-tracker
make check PI_MODEL=...            # override the model the live tiers drive
```

`npm test` and `npm run typecheck` also run on the host from inside a package, with no container
and no pi installed. The other two scripts need pi on `PATH`, so they need the container.

Single test file / group:

```bash
cd pi-issue-tracker
node --test test/epic.test.ts                   # one unit group
node --test test/tui/start-epic.test.ts         # one interactive group (needs pi on PATH;
                                                # export PI_PROVIDER/PI_MODEL if it has a live case)
PI_TUI_KEEP=1 node --test test/tui/merge-epic.test.ts   # keep the fixture and print its path
```

`make check` **calls a LLM API and costs money**: an extension only exists inside a running pi
session, so the only coverage `extensions/index.ts` has is a real model driving it. Three tiers
spend money — `test/container/test_extension_live.sh`, and cases B1/B3/I1/W10 in `test/tui/`.
`PI_TUI_SKIP_LIVE=1` opts the interactive tier out (used by the fork CI job).

## Repo-wide invariants

- **Everything version-pinned lives in [shared/versions.env](shared/versions.env)** — the test image
  digest, the live model, the pi release. Three consumers read it (Makefile via `include`, shell/npm
  via `shared/versions.sh` or `shared/with-versions.sh`, CI via `$DEFAULT_PI_VERSION`). Names are
  `DEFAULT_`-prefixed and each maps to its real name only when unset, which is what keeps
  `make check PI_MODEL=...` and CI `env:` overrides working. Never duplicate a pin elsewhere.
- **`make dev` is the only supported way into the dev container.** The inner podman's image store
  must be the `pi-dev-storage` volume the Makefile mounts; started another way (VS Code's "Reopen in
  Container") it lands on the container's 8 GB overlay and fills it. There is deliberately no
  `devcontainer.json`. Attach VS Code to the running `pi-dev` container instead.
- **A package's `node_modules/` is a symlink farm** into the container's global pi install. A real
  `npm install` at a package root reifies and prunes it. The compiler and pi's declarations live off
  to one side in `shared/typecheck/` (large directory, gitignored, one install for the repo);
  `shared/tsconfig.base.json`'s `paths` map `@earendil-works/*` onto declaration *files* there — map
  to a directory and every pi type silently degrades to `any`, which type-checks clean and proves
  nothing.
- **The host mount arrives root-owned and 0600** under podman machine's virtiofs on macOS, so a
  read-only bind is unreadable to the distroless image's uid 65532. `stage_pkg` in
  `shared/test/container/lib.sh` copies and normalises modes before mounting.
- **Every live pi call has a time budget** (`PI_TIMEOUT`, 240s). A model holding a bash tool has no
  natural stopping point; an unbounded live test is one curious model away from wedging CI.

## Adding an extension

Registration is two lines: `PKGS` in the [Makefile](Makefile) and `matrix.pkg` in
[.github/workflows/test.yml](.github/workflows/test.yml). Then a `tsconfig.json` extending
`../shared/tsconfig.base.json` with nothing but `include`, whichever npm scripts it wants (every
target uses `npm run … --if-present`, so omitted tiers are skipped, not failed), and optionally a
three-line `test/container/run.sh` delegating to `shared/test/container/run-suites.sh`.

Keep fixtures, inspectors and live suites local to a package: they encode one extension's semantics and
are cheaper duplicated than abstracted. `shared/` is only for common infrastructure.


## Architecture of the extensions

Read the respective README (e.g. pi-issue-tracker/README.md ) for high-level guidance.

### Tests

Four tiers, each covering what the one below structurally cannot:

| Tier | Command | Reaches |
|---|---|---|
| unit | `npm test` | `src/`, against a temp repo built under `mkdtemp` with `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/`HOME` redirected into it |
| types | `npm run typecheck` | `src/`, `extensions/`, `test/` against pi's real declarations |
| interactive | `npm run test:tui` | the ten slash commands and the story board — pi dispatches commands from its TUI alone, so cases run pi under `script(1)` in a pty |
| container | `npm run test:container` | the same unit suites in the pinned distroless image, then a real model driving the extension |

Interactive cases: build a fixture by calling `src/` (not by scripting git), drive pi, `close()`,
*then* assert — pi holds the database in WAL mode and serialises git effects through a promise
chain, so reading either while the session is alive races it. Details in
[test/tui/README.md](pi-issue-tracker/test/tui/README.md).
