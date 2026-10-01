#!/usr/bin/env bash
# The host toolchain pi-lean4's Lean tier runs against: elan, one pinned Lean
# toolchain, and ripgrep.
#
#   scripts/toolchain.sh install   put the pinned versions on this host
#   scripts/toolchain.sh update    converge onto the pins again, and say what
#                                  upstream has released since they were set
#   scripts/toolchain.sh check     exit non-zero, with the remedy, unless the
#                                  host can run `npm run test:lean`
#
# The pins are LEAN_TOOLCHAIN, ELAN_VERSION and RIPGREP_VERSION, read from
# shared/versions.env through ../shared/with-versions.sh — never from here.
# `update` reports newer releases and stops there: moving a pin is an edit to
# that file and a re-run of test/lean/contract.test.ts, not a side effect.
# For the same reason it never runs `elan self update`, which would leave the
# host on whatever elan released last.
#
# No sudo and nothing outside $HOME: elan goes to ${ELAN_HOME:-~/.elan}, rg to
# ${BIN_DIR:-~/.local/bin}. Linux and macOS, x86_64 and aarch64. Written for
# bash 3.2, which is what macOS still ships as /bin/bash.
set -euo pipefail

: "${LEAN_TOOLCHAIN:?run through ../shared/with-versions.sh (LEAN_TOOLCHAIN is unset)}"
: "${ELAN_VERSION:?run through ../shared/with-versions.sh (ELAN_VERSION is unset)}"
: "${RIPGREP_VERSION:?run through ../shared/with-versions.sh (RIPGREP_VERSION is unset)}"

ELAN_HOME="${ELAN_HOME:-$HOME/.elan}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
ELAN="$ELAN_HOME/bin/elan"
RG="$BIN_DIR/rg"

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# elan publishes glibc builds for Linux; ripgrep's musl builds are static, so
# they run on any Linux userland, including the distroless one.
platform() {
	local os arch
	os="$(uname -s)"
	arch="$(uname -m)"
	case "$arch" in
		x86_64 | amd64) arch=x86_64 ;;
		aarch64 | arm64) arch=aarch64 ;;
		*) die "unsupported architecture: $arch" ;;
	esac
	case "$os" in
		Linux)
			ELAN_TRIPLE="$arch-unknown-linux-gnu"
			RG_TRIPLE="$arch-unknown-linux-musl"
			;;
		Darwin)
			ELAN_TRIPLE="$arch-apple-darwin"
			RG_TRIPLE="$arch-apple-darwin"
			;;
		*) die "unsupported OS: $os (Linux and macOS only)" ;;
	esac
}

fetch() { # url dest
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 3 -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1"
	else
		die "neither curl nor wget is available"
	fi
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

# `elan --version` prints "elan 4.2.4 (<hash> <date>)"; the pin carries a v.
elan_version() { "$ELAN" --version 2>/dev/null | awk '{print "v" $2}'; }
# `rg --version` prints "ripgrep 15.2.0 (rev ...)" on its first line.
rg_version() { "$1" --version 2>/dev/null | awk 'NR==1 {print $2}'; }
toolchain_installed() { "$ELAN" toolchain list 2>/dev/null | grep -qF "$LEAN_TOOLCHAIN"; }

TMP=""
cleanup() { if [ -n "$TMP" ]; then rm -rf "$TMP"; fi; }
trap cleanup EXIT
tmpdir() { if [ -z "$TMP" ]; then TMP="$(mktemp -d)"; fi; }

install_elan() {
	if [ -x "$ELAN" ] && [ "$(elan_version)" = "$ELAN_VERSION" ]; then
		say "elan $ELAN_VERSION already at $ELAN_HOME"
		return
	fi
	tmpdir
	say "installing elan $ELAN_VERSION ($ELAN_TRIPLE) into $ELAN_HOME"
	fetch "https://github.com/leanprover/elan/releases/download/$ELAN_VERSION/elan-$ELAN_TRIPLE.tar.gz" "$TMP/elan.tar.gz"
	tar -xzf "$TMP/elan.tar.gz" -C "$TMP"
	# --default-toolchain none: the pin below is installed by name, and every
	# fixture names it in lean-toolchain, so no default is ever consulted.
	ELAN_HOME="$ELAN_HOME" "$TMP/elan-init" -y --default-toolchain none --no-modify-path >/dev/null
	[ "$(elan_version)" = "$ELAN_VERSION" ] || die "elan-init ran but $ELAN reports $(elan_version)"
}

install_toolchain() {
	if toolchain_installed; then
		say "$LEAN_TOOLCHAIN already installed"
		return
	fi
	say "installing $LEAN_TOOLCHAIN"
	"$ELAN" toolchain install "$LEAN_TOOLCHAIN"
}

install_rg() {
	if [ -x "$RG" ] && [ "$(rg_version "$RG")" = "$RIPGREP_VERSION" ]; then
		say "ripgrep $RIPGREP_VERSION already at $RG"
		return
	fi
	tmpdir
	local name="ripgrep-$RIPGREP_VERSION-$RG_TRIPLE"
	local base="https://github.com/BurntSushi/ripgrep/releases/download/$RIPGREP_VERSION/$name.tar.gz"
	say "installing ripgrep $RIPGREP_VERSION ($RG_TRIPLE) into $BIN_DIR"
	fetch "$base" "$TMP/rg.tar.gz"
	fetch "$base.sha256" "$TMP/rg.sha256"
	local want got
	want="$(awk '{print $1}' "$TMP/rg.sha256")"
	got="$(sha256_of "$TMP/rg.tar.gz")"
	[ "$want" = "$got" ] || die "ripgrep checksum mismatch: expected $want, got $got"
	tar -xzf "$TMP/rg.tar.gz" -C "$TMP"
	mkdir -p "$BIN_DIR"
	# Through a temp name and a rename, so a running rg is never half-written.
	cp "$TMP/$name/rg" "$BIN_DIR/.rg.new"
	chmod 755 "$BIN_DIR/.rg.new"
	mv -f "$BIN_DIR/.rg.new" "$RG"
}

path_hint() {
	case ":$PATH:" in *":$ELAN_HOME/bin:"*) ;; *) say "add to PATH: $ELAN_HOME/bin" ;; esac
	case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "add to PATH: $BIN_DIR" ;; esac
}

latest() { # owner/repo → tag of the latest stable release, or "?" offline
	local tag
	tag="$(curl -fsSL "https://api.github.com/repos/$1/releases/latest" 2>/dev/null |
		sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)" || true
	printf '%s' "${tag:-?}"
}

cmd_install() {
	platform
	install_elan
	install_toolchain
	install_rg
	path_hint
}

cmd_update() {
	cmd_install
	local others
	others="$("$ELAN" toolchain list 2>/dev/null | grep -vF "$LEAN_TOOLCHAIN" || true)"
	if [ -n "$others" ]; then
		say "other toolchains on this host (left alone; \`elan toolchain uninstall\` to reclaim them):"
		printf '%s\n' "$others" | sed 's/^/  /'
	fi
	say ""
	say "pins (shared/versions.env) vs latest upstream releases:"
	say "  lean    ${LEAN_TOOLCHAIN#leanprover/lean4:}  latest $(latest leanprover/lean4)"
	say "  elan    $ELAN_VERSION  latest $(latest leanprover/elan)"
	say "  ripgrep $RIPGREP_VERSION  latest $(latest BurntSushi/ripgrep)"
	say "a newer release is adopted by editing shared/versions.env, never by this script."
}

cmd_check() {
	local ok=1
	if [ ! -x "$ELAN" ]; then
		warn "elan is not installed at $ELAN"
		ok=0
	elif [ "$(elan_version)" != "$ELAN_VERSION" ]; then
		warn "elan is $(elan_version), pinned $ELAN_VERSION (make lean-update)"
	fi
	if [ -x "$ELAN" ] && ! toolchain_installed; then
		warn "$LEAN_TOOLCHAIN is not installed"
		ok=0
	fi
	if [ -x "$RG" ]; then
		[ "$(rg_version "$RG")" = "$RIPGREP_VERSION" ] ||
			warn "ripgrep is $(rg_version "$RG"), pinned $RIPGREP_VERSION (make lean-update)"
	elif ! command -v rg >/dev/null 2>&1; then
		warn "ripgrep is not installed (looked at $RG and on PATH)"
		ok=0
	fi
	if [ "$ok" = 1 ]; then
		say "lean toolchain ok: $LEAN_TOOLCHAIN via $ELAN_HOME, rg $(rg_version "$(command -v rg 2>/dev/null || echo "$RG")")"
	else
		die "the host cannot run pi-lean4's Lean tier — run: make lean-install"
	fi
}

case "${1:-}" in
	install) cmd_install ;;
	update) cmd_update ;;
	check) cmd_check ;;
	*) die "usage: $0 install|update|check" ;;
esac
