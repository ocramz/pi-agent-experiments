ENGINE      ?= podman
DEV_IMAGE   ?= localhost/pi-dev:local
DEV_NAME    ?= pi-dev
# Pinned by digest, not by :latest. The git capability probe asserts what this
# userland's perl-less git can do, and that claim is only worth anything against
# a known image — on a moving tag a base-image change would alter the result
# silently. Keep in step with IMAGE in .github/workflows/test.yml; re-pin with
#   podman pull ghcr.io/ocramz/pi-container-distroless-node24:latest
#   podman inspect ... --format '{{index .RepoDigests 0}}'
TEST_IMAGE  ?= ghcr.io/ocramz/pi-container-distroless-node24@sha256:46bbab3a97cbcfeb89fe362c60ab8f589510354b2fe86d0b177f063b8f5810bf
ENV_FILE    ?= .env
CONFIG_VOL  ?= pi-config
STORAGE_VOL ?= pi-dev-storage
PKG         ?= pi-issue-tracker
# The live suite spends money, and the live tier is the only coverage extensions/index.ts
# has. deepseek-v4-flash is the cheapest model in the catalog that still drives
# tool calls reliably: the suite needs the model to actually call the story tool
# and the bash tool, and weaker ones narrate instead. A concrete id, not the
# `-latest` alias, so a catalog change cannot move it underneath the tests.
# Override with `make check PI_MODEL=...` to compare.
PI_PROVIDER ?= openrouter
PI_MODEL    ?= deepseek/deepseek-v4-flash

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
            -e PI_PROVIDER=$(PI_PROVIDER) -e PI_MODEL=$(PI_MODEL)

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

# One-shot and disposable, so a laptop and CI run the same thing. Includes the
# live suite, which calls a model API and costs money.
test-container: image $(ENV_FILE)
	$(ENGINE) run --rm $(RUN_FLAGS) -w /workspace/$(PKG) $(DEV_IMAGE) \
	  bash -lc 'IMAGE=$(TEST_IMAGE) npm run test:container'

test: image $(ENV_FILE)
	$(ENGINE) run --rm $(RUN_FLAGS) -w /workspace/$(PKG) $(DEV_IMAGE) bash -lc 'npm test'

# Needs no key, but $(RUN_FLAGS) carries --env-file, so $(ENV_FILE) is still a
# prerequisite. Runs equally well on the host: `cd $(PKG) && npm run typecheck`.
typecheck: image $(ENV_FILE)
	$(ENGINE) run --rm $(RUN_FLAGS) -w /workspace/$(PKG) $(DEV_IMAGE) bash -lc 'npm run typecheck'

# The interactive tier. Runs in this image rather than the distroless test image
# because it needs pi on PATH, npm to install its own dependencies, and `script`
# to give pi a pty — none of which the distroless userland has. The three
# model-driven cases use $(PI_MODEL), same as the live container suite.
test-tui: image $(ENV_FILE)
	$(ENGINE) run --rm $(RUN_FLAGS) -w /workspace/$(PKG) $(DEV_IMAGE) bash -lc 'npm run test:tui'

check: test typecheck test-tui test-container

# The inner image cache and the dev container. Leaves $(CONFIG_VOL) alone — that
# is the pi login.
clean: dev-stop
	- $(ENGINE) volume rm $(STORAGE_VOL)

.PHONY: image dev shell dev-stop test typecheck test-tui test-container check clean
