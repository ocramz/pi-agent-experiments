# pi-agent-experiments

Experiments with the Pi coding agent

# Set up

Development happens inside a container, and the test suite starts containers of
its own, so the outer one needs a handful of flags to make nested podman work.
The Makefile is those flags.

```bash
cp env.example .env       # then set OPENROUTER_API_KEY

make dev                  # build + start the dev container, detached
make shell                # a shell in it (or attach VS Code to "pi-dev")
```

`make dev` mounts three things and nothing else: this checkout at `/workspace`,
a named volume for pi's credentials and sessions, and a named volume for the
inner podman's image store.

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
pty, types into it, and reads what it rendered. Three of its 38 cases drive a
model; the rest are local and free. See
[test/tui/README.md](pi-issue-tracker/test/tui/README.md).

Without `.env`, `make` stops and says so; without `OPENROUTER_API_KEY` in it, the
container and interactive suites exit rather than skipping their live cases
quietly.
