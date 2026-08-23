ARG BASE=ghcr.io/ocramz/pi-container-debian-slim:latest
FROM ${BASE}

# The nested engine. slirp4netns gives each inner test container its own network
# namespace with egress — the live suite calls a model API, so a no-network
# default is not an option. fuse-overlayfs and uidmap are fallback paths; see the
# Makefile comment on --device /dev/fuse.
# The last two are for the interactive tier, and neither is incidental.
# util-linux provides `script(1)`, the pty test/tui/ runs pi inside — without it
# every case lands pi in print mode, where slash commands are never parsed.
# procps provides `ps`, which cli-testing-library's cleanup shells out to through
# tree-kill; without it a failed case cannot reap its pi process.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      podman slirp4netns fuse-overlayfs uidmap ca-certificates util-linux procps \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY containers.conf /etc/containers/containers.conf

# The bind-mounted repo is owned by the host uid, not this container's root.
RUN git config --system --add safe.directory '*'

# Files written in here are read by the inner test container as uid 65532. A 077
# umask makes them unreadable, which empties the in-image test run rather than
# failing it — see test_unit_in_image.sh.
RUN printf 'umask 022\n' > /etc/profile.d/umask.sh

# The base image's entrypoint is `pi`; this image is a shell to work in.
ENTRYPOINT []
CMD ["bash"]
