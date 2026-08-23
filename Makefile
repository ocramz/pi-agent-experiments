ENGINE      ?= podman
DEV_IMAGE   ?= localhost/pi-dev:local
DEV_NAME    ?= pi-dev
ENV_FILE    ?= .env
CONFIG_VOL  ?= pi-config
STORAGE_VOL ?= pi-dev-storage

# The image digest, the live model and the pi release, pinned once for the whole
# repo. Everything here and in the shell suites reads them from that one file;
# see the comments there for how to re-pin the digest. The DEFAULT_ prefix is
# what keeps `make check PI_MODEL=...` working — a command-line variable beats
# the `?=` below, which in turn beats the file.
include shared/versions.env
TEST_IMAGE  ?= $(DEFAULT_TEST_IMAGE)
PI_PROVIDER ?= $(DEFAULT_PI_PROVIDER)
PI_MODEL    ?= $(DEFAULT_PI_MODEL)
# Empty by default: shared/versions.sh then falls back to the working model
# inside the container, so the reviewer block costs one extra call and no second
# pin. `make check PI_REVIEW_MODEL=...` points it at a different reviewer.
PI_REVIEW_PROVIDER ?= $(DEFAULT_PI_REVIEW_PROVIDER)
PI_REVIEW_MODEL    ?= $(DEFAULT_PI_REVIEW_MODEL)

# Every extension in the repo. `make check` runs the lot; PKG=... narrows any
# target to one. Adding an extension is a one-line edit here and one in
# .github/workflows/test.yml — see "Adding an extension" in the README.
PKGS        ?= pi-issue-tracker
# What the test targets iterate over: PKG if it was given, otherwise all of them.
TARGETS      = $(if $(PKG),$(PKG),$(PKGS))

# Minimal security flags for nested podman. 
#   unmask=/proc/*      podman masks paths inside /proc; the kernel then refuses
#                       to mount a fresh procfs in the inner userns, and crun
#                       cannot write net.ipv4.ping_group_range.
#   seccomp=unconfined  the inner crun calls sethostname().
#   label=disable       the podman machine VM is SELinux-enforcing Fedora CoreOS.
#   /dev/net/tun        slirp4netns opens it to build the inner netns. This is
#                       Its absence was long mistaken for a hard sandbox limit.
# Note the quotes on unmask: unquoted, /proc/* globs on a Linux host.
# --cap-add SYS_ADMIN is deliberately absent — it makes the inner podman try to
# manage cgroups and fail on a read-only /sys/fs/cgroup.
NEST_FLAGS = \
  --security-opt label=disable \
  --security-opt seccomp=unconfined \
  --security-opt 'unmask=/proc/*' \
  --device /dev/net/tun \
  --device /dev/fuse

# /dev/fuse is insurance: with STORAGE_VOL the inner graphroot sits on a real
# filesystem and native overlay works. Drop the volume and podman falls back to
# fuse-overlayfs, which needs the device.

# Minimal volumes: the source tree, the inner image cache (which also keeps the
# inner graphroot off the outer overlayfs), and pi's credentials and sessions.
MOUNTS = \
  -v "$(CURDIR)":/workspace \
  -v $(STORAGE_VOL):/var/lib/containers/storage \
  -v $(CONFIG_VOL):/root/.pi

# No -w here: each target sets its own working directory, and two -w flags on one
# command line is confusing to read even though podman takes the last.
RUN_FLAGS = $(NEST_FLAGS) $(MOUNTS) --env-file $(ENV_FILE) \
            -e PI_PROVIDER=$(PI_PROVIDER) -e PI_MODEL=$(PI_MODEL) \
            -e PI_REVIEW_PROVIDER=$(PI_REVIEW_PROVIDER) -e PI_REVIEW_MODEL=$(PI_REVIEW_MODEL) \
            -e PI_TUI_SKIP_LIVE=$(PI_TUI_SKIP_LIVE)

# The documented opt-out from the money-spending interactive cases. It is read
# inside the container by test/tui/live.test.ts, so it has to be forwarded —
# `make test-tui PI_TUI_SKIP_LIVE=1` silently ran them before this existed.
PI_TUI_SKIP_LIVE ?=

$(ENV_FILE):
	@echo "$(ENV_FILE) is missing. cp env.example $(ENV_FILE) and set OPENROUTER_API_KEY." >&2
	@exit 1

image:
	$(ENGINE) build -t $(DEV_IMAGE) -f .devcontainer/Dockerfile .devcontainer

# Long-lived and detached, so VS Code can attach and the container outlives the
# terminal that started it.
dev: image $(ENV_FILE)
	- $(ENGINE) rm -f $(DEV_NAME) 2>/dev/null
	$(ENGINE) run -d --name $(DEV_NAME) $(RUN_FLAGS) -w /workspace $(DEV_IMAGE) sleep infinity
	@echo "attach VS Code to '$(DEV_NAME)', or run: make shell"

shell:
	$(ENGINE) exec -it $(DEV_NAME) bash

dev-stop:
	- $(ENGINE) rm -f $(DEV_NAME)

# Run one npm script in every target package, stopping at the first failure.
#
# `npm run <script> --if-present` rather than `npm run <script>` is the whole of
# the multi-package story: an extension with no interactive tier and no container
# tier simply has no such script, and the loop skips it instead of failing. No
# discovery, no per-package configuration, no manifest.
#
# The `set -e` matters: each recipe line is one shell, and without it a failing
# package would be reported and the loop would carry on to the next.
define for_each_pkg
	@set -e; for pkg in $(TARGETS); do \
	  printf '\n=== %s: %s ===\n' "$$pkg" "$(1)"; \
	  $(ENGINE) run --rm $(RUN_FLAGS) -w /workspace/$$pkg $(DEV_IMAGE) \
	    bash -lc 'npm run $(1) --if-present'; \
	done
endef

# One-shot and disposable, so a laptop and CI run the same thing. Includes the
# live suite, which calls a model API and costs money.
test-container: image $(ENV_FILE)
	$(call for_each_pkg,test:container)

test: image $(ENV_FILE)
	$(call for_each_pkg,test)

# Needs no key, but $(RUN_FLAGS) carries --env-file, so $(ENV_FILE) is still a
# prerequisite. Runs equally well on the host: `cd $(PKG) && npm run typecheck`.
typecheck: image $(ENV_FILE)
	$(call for_each_pkg,typecheck)

# The interactive tier. Runs in this image rather than the distroless test image
# because it needs pi on PATH, npm to install its own dependencies, and `script`
# to give pi a pty — none of which the distroless userland has. The
# model-driven cases use $(PI_MODEL), same as the live container suite.
test-tui: image $(ENV_FILE)
	$(call for_each_pkg,test:tui)

# The image's own suite: the git capability probe. A property of the pinned
# digest, not of any package, so it runs once for the repo rather than once per
# extension — and it runs first, because every design here assumes worktrees and
# `stash create` exist.
test-image: image $(ENV_FILE)
	$(ENGINE) run --rm $(RUN_FLAGS) -w /workspace $(DEV_IMAGE) \
	  bash -lc 'IMAGE=$(TEST_IMAGE) shared/test/container/run-image-tests.sh'

check: test-image test typecheck test-tui test-container

# The inner image cache and the dev container. Leaves $(CONFIG_VOL) alone — that
# is the pi login.
clean: dev-stop
	- $(ENGINE) volume rm $(STORAGE_VOL)

.PHONY: image dev shell dev-stop test typecheck test-tui test-container test-image check clean
