# pi-agent-experiments

Experiments with the [Pi coding agent](https://pi.dev). A monorepo: one directory per pi
extension, plus a `shared/` directory holding the build and test tooling they have in common.

| | |
|---|---|
| [pi-issue-tracker/](pi-issue-tracker/) | Turns goals into linked, tracked user stories in a project-local SQLite database |
| [pi-incremental-py/](pi-incremental-py/) | An incremental computing kernel for Python, plus the pi extension that drives it |
| [pi-notebook-py/](pi-notebook-py/) | The same idea with Jupyter's semantics: an ordered list of cells over one namespace, with staleness hints, percent-format files and plots the model can see |
| [pi-web-search/](pi-web-search/) | Web search as agent tools, one per backend, normalised into a shared result shape (first backend: Tavily) |
| [shared/](shared/) | Version pins, the tsconfig base, and the shell + pty test harnesses |

# Development

## Secrets

All secrets go in `.env` at the repo top level: `OPENROUTER_API_KEY` for every tier that drives a
model, plus whatever an extension's own backend needs — `TAVILY_API_KEY` for
[pi-web-search/](pi-web-search/).

## Containers

We run pi inside a container, and the test suite starts containers of
its own, so the outer one needs a handful of flags to make nested podman work.
The Makefile specifies all the flags.

```bash
make dev                  # build + start the dev container, detached
make shell                # a shell in it (or attach VS Code to "pi-dev")
```

### Dev container configuration and secrets
NB: The dev container sources **all** secrets from `.env` and mounts the following volumes :
- the current directory at `/workspace`,
- a named volume for pi's credentials and sessions,
- and a named volume for the inner podman's image store.



## Tests

```bash
make check                # everything below, in order
make test-image           # the pinned image's git capabilities (once, not per package)
make test                 # host unit suites
make typecheck            # types only, against pi's real declarations
make test-tui             # interactive suites (pi's real TUI, in a pty)
make test-container       # container suites
make pack                 # what each package would publish (host only, no key)
```

Every target except `test-image` runs over all of `PKGS`. Narrow any of them to one
extension with `PKG=`:

```bash
make test PKG=pi-issue-tracker
```

`npm test` and `npm run typecheck` also run directly on the host from inside a package, with no
container and no pi installed — the type-check installs the compiler and pi's declarations into
`shared/typecheck` the first time (260 MB, gitignored, pinned by a lockfile).

`make check` **calls a model API and costs money**. An extension only exists inside a running pi
session — its tools and hooks have no other entry point — so the only way to test an
`extensions/index.ts` is to let a real model drive it. For the tracker that tier is
`pi-issue-tracker/test/container/test_extension_live.sh`, and it runs last. Override the model
with `make check PI_MODEL=...`.

The commands and the story board are reached from the other side: pi dispatches
slash commands from its TUI alone, so `pi-issue-tracker/test/tui/` runs pi in a
pty, types into it, and reads what it rendered. Three of its 43 cases drive a
model; the rest are local and free. See
[test/tui/README.md](pi-issue-tracker/test/tui/README.md).

Without `.env`, `make` stops and says so; without `OPENROUTER_API_KEY` in it, the
container and interactive suites exit rather than skipping their live cases
quietly. `pi-web-search/test/tui/live.test.ts` does the same, and needs
`TAVILY_API_KEY` as well as the model key.

## Adding an extension

1. **A directory at the repo root**, added to `PKGS` in the [Makefile](Makefile) and to
   `matrix.pkg` in [.github/workflows/test.yml](.github/workflows/test.yml). Those two lines
   are the entire registration.
2. **A `tsconfig.json`** that extends the shared base and lists its own sources:
   ```jsonc
   { "extends": "../shared/tsconfig.base.json",
     "include": ["src/**/*.ts", "extensions/**/*.ts", "test/**/*.ts"] }
   ```
   Add `"../shared/test/tui/**/*.ts"` only if the package has an interactive tier.
3. **Whichever npm scripts it wants** — `test`, `typecheck`, `test:container`, `test:tui`.
   Every Makefile target and CI step uses `npm run … --if-present`, so an extension with no
   TUI and no container tier simply omits those two and is skipped, rather than failing.
4. **Optionally a `test/container/run.sh`**, three lines naming its own suites and delegating
   to `shared/test/container/run-suites.sh` — which supplies the engine smoke test, the
   architecture diagnostics, the inner-store guard and the pinned digest. Set
   `REQUIRE_API_KEY=1` there only if one of those suites drives a model.

5. **The publishing metadata**, if it is meant to reach npm: a `@ocramz/`-scoped `name`,
   `publishConfig.access: "public"` (scoped packages default to private, and a published
   version cannot be replaced), `homepage`/`bugs`, a `files` allowlist, `pi.extensions`, the
   `pi-package` keyword, the four core pi packages as *optional* peer dependencies, and a
   `pack-check` script. Copy [pi-web-search/package.json](pi-web-search/package.json) — it is
   the smallest complete one. Then add an `## Install` section to its README.

What is worth *not* sharing: fixtures, inspectors and live suites encode one extension's
semantics, and are cheaper duplicated than abstracted. `shared/` is for things whose answer
cannot differ between packages.

## Releasing

Each extension is published to npm independently, under the `@ocramz` scope.

```bash
make pack PKG=pi-web-search               # read the file list first
$EDITOR pi-web-search/package.json        # bump "version"
git commit -am "pi-web-search 0.2.0" && git push
git tag pi-web-search-v0.2.0 && git push --tags
```

The tag is the release CI trigger :
[.github/workflows/publish-npm.yml](.github/workflows/publish-npm.yml) parses
`<directory>-v<version>` out of it, **refuses to publish if that version disagrees with
package.json**, re-runs the two free tiers, checks the tarball, and publishes with a
provenance attestation. The directory name is the tag prefix because a git ref cannot
contain `@` or `/`.

Two things to know:

- **The first publish of a new package is manual.** npm's trusted-publisher setting lives on
  an *existing* package, so there is nothing to configure until one exists. Publish it once
  by hand (`npm publish --dry-run`, read the list, then `npm publish --access public`), then
  set Trusted Publisher → GitHub Actions on npmjs.com for that package. Everything after
  that goes through the tag, with no long-lived token stored in the repo.
- **`files` is an allowlist and nothing else guards it.** A directory entry matches whatever
  the toolchain left under it; `files: ["py/"]` once made five `__pycache__/*.pyc` into 77%
  of a tarball. [shared/check-tarball.mjs](shared/check-tarball.mjs) runs on every CI run and
  behind `make pack`, and also asserts the reverse — that everything `pi.extensions` names
  actually survived into the tarball, since a package missing its own entry point installs
  cleanly and fails at load.

## Where things live

| | |
|---|---|
| [shared/versions.env](shared/versions.env) | The image digest, the live model, the pi release. Pinned **once**; the Makefile includes it, the shell scripts load it through `versions.sh`, CI reads `PI_VERSION` from it |
| [shared/tsconfig.base.json](shared/tsconfig.base.json) | Compiler settings and the `paths` that map `@earendil-works/*` onto real declaration files |
| [shared/typecheck/](shared/typecheck/) | The 260 MB dependency scope those paths point into. One install for the repo |
| [shared/test/assert.sh](shared/test/assert.sh) | `ok` / `fail` / `assert_*` / `summary` for every shell suite |
| [shared/test/container/](shared/test/container/) | `lib.sh` (staging and `in_image`), `run-suites.sh` (the driver), and the image's own git capability probe |
| [shared/test/tui/](shared/test/tui/) | `pi-session.ts`, the pty harness, and the dependency scope it imports from |

## Good to know

- **The host mount arrives root-owned and 0600.** Podman machine's virtiofs
  presents every host file that way on macOS regardless of its real mode, so a
  read-only bind of the checkout is unreadable to the distroless image's uid
  65532. `stage_pkg` in `shared/test/container/lib.sh` copies the package and
  normalises modes before mounting it. Without that the in-image suite copies
  nothing and passes vacuously — which is exactly what it used to do.
- **`make dev` is the only supported way into the dev container.** The inner
  podman's image store has to be the `pi-dev-storage` volume the Makefile mounts
  at `/var/lib/containers/storage`. Started any other way — VS Code's "Reopen in
  Container" used to do this — the store lands on the container's own 8 GB
  overlay and the test rig quietly fills it; that cost 2.1 GB once. There is no
  `devcontainer.json` for this reason. `run-suites.sh` refuses to start when it
  is nested and the store is not a mounted volume; `PI_ALLOW_UNMOUNTED_STORE=1`
  overrides. Attach VS Code to the running `pi-dev` container instead.
- **Every live pi call has a time budget** (`PI_TIMEOUT`, 240s). One run once
  blocked for twenty minutes on `grep -r "strand its work" /`: the branch guard
  had blocked the model, and it went looking through the whole filesystem for the
  source of the message. A model holding a bash tool has no natural stopping
  point, so an unbounded live test is one curious model away from wedging CI.
- **The test image is pinned by digest**, in `shared/versions.env` and nowhere
  else. It used to be written in three files, each with a comment saying the
  three had to move together. The git capability probe asserts what that
  userland's perl-less git can do, and the claim means nothing against a moving
  tag — see the re-pinning instructions in that file.
- **A package's `node_modules/` is a symlink farm** into the global pi install,
  so `tsc` can resolve `@earendil-works/*` at runtime. It is gitignored, and a
  real `npm install` replaces it. The compiler and pi's declarations live off to
  one side in `shared/typecheck/` because they are 260 MB and the container
  harness copies the package it stages.
