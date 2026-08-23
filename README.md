# pi-agent-experiments

Experiments with the [Pi coding agent](https://pi.dev)

# Set up

For security, we run pi inside a container, and the test suite starts containers of
its own, so the outer one needs a handful of flags to make nested podman work.
The Makefile specifies all the flags.

```bash
cp env.example .env       # then set OPENROUTER_API_KEY

make dev                  # build + start the dev container, detached
make shell                # a shell in it (or attach VS Code to "pi-dev")
```

`make dev` mounts volumes : 
- this checkout at `/workspace`,
- a named volume for pi's credentials and sessions, 
- and a named volume for the inner podman's image store.

# Tests

```bash
make check                # everything below, in order
make test                 # host unit suite only
make typecheck            # types only, against pi's real declarations
make test-tui             # interactive suite only (pi's real TUI, in a pty)
make test-container       # container suite only
```

`npm test` and `npm run typecheck` also run directly on the host, with no
container and no pi installed — the type-check installs the compiler and pi's
declarations into `pi-issue-tracker/tools/typecheck` the first time (250 MB,
gitignored, pinned by a lockfile).

`make check` **calls a model API and costs money**. The extension only exists
inside a running pi session — its tools and hooks have no other entry point — so
the only way to test `extensions/index.ts` is to let a real model drive it. That
tier lives in `pi-issue-tracker/test/container/test_extension_live.sh` and runs
last. Override the model with `make check PI_MODEL=...`.

The commands and the story board are reached from the other side: pi dispatches
slash commands from its TUI alone, so `pi-issue-tracker/test/tui/` runs pi in a
pty, types into it, and reads what it rendered. Three of its 43 cases drive a
model; the rest are local and free. See
[test/tui/README.md](pi-issue-tracker/test/tui/README.md).

Without `.env`, `make` stops and says so; without `OPENROUTER_API_KEY` in it, the
container and interactive suites exit rather than skipping their live cases
quietly.

## Things that will otherwise cost you an afternoon

- **The host mount arrives root-owned and 0600.** Podman machine's virtiofs
  presents every host file that way on macOS regardless of its real mode, so a
  read-only bind of the checkout is unreadable to the distroless image's uid
  65532. `stage_pkg` in `pi-issue-tracker/test/container/lib.sh` copies the
  package and normalises modes before mounting it. Without that the in-image
  suite copies nothing and passes vacuously — which is exactly what it used to do.
- **Every live pi call has a time budget** (`PI_TIMEOUT`, 240s). One run once
  blocked for twenty minutes on `grep -r "strand its work" /`: the branch guard
  had blocked the model, and it went looking through the whole filesystem for the
  source of the message. A model holding a bash tool has no natural stopping
  point, so an unbounded live test is one curious model away from wedging CI.
- **The test image is pinned by digest** in two places that must move together:
  `TEST_IMAGE` here and `IMAGE` in `.github/workflows/test.yml`. The git
  capability probe asserts what that userland's perl-less git can do, and the
  claim means nothing against a moving tag.
- **`pi-issue-tracker/node_modules/` is a symlink farm** into the global pi
  install, so `tsc` can resolve `@earendil-works/*`. It is gitignored, and a real
  `npm install` replaces it. The compiler and pi's declarations live off to one
  side in `pi-issue-tracker/tools/typecheck/` because they are 250 MB and the
  container harness copies the package.
