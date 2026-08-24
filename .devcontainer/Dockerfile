ARG BASE=ghcr.io/ocramz/pi-container-debian-slim:latest
# The image pi-incremental-py's container tier runs in. Only its interpreter is
# wanted here; it is the source rather than a fresh `uv python install` so the
# dev container and that tier run the *same* build — "it passed in here" and "it
# passed in the image" then mean the same thing — and so hypothesis, which that
# image already carries for the property suite, comes along with it.
#
# No default on purpose: the pin lives in shared/versions.env and nowhere else,
# and `make image` passes it. A hand-run `podman build` should fail loudly here
# rather than quietly resolve some other image.
ARG PY_IMAGE
FROM ${PY_IMAGE} AS py

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

# Six of pi-incremental-py's unit cases spawn a real interpreter and all six of
# its /py TUI cases drive a live kernel, so without this `make test` and
# `make test-tui` cannot pass for that package in here.
COPY --from=py /opt/python3 /opt/python3
# The base's PATH with one entry prepended; ENV replaces rather than appends.
ENV PATH=/opt/python3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# ENV alone is not enough: every Makefile target runs `bash -lc`, and Debian's
# /etc/profile assigns PATH outright for root, dropping the entry above. The
# profile.d snippet is what survives a login shell.
RUN printf 'PATH=/opt/python3/bin:$PATH\n' > /etc/profile.d/python3.sh

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
