#!/usr/bin/env bash
# Shepherd cold-start bootstrap — the `curl|bash` entry point.
#
#   curl -fsSL https://raw.githubusercontent.com/erwins-enkel/shepherd/main/deploy/install.sh | bash
#
# THIN bootstrap: does only what must happen before Bun + a checkout exist — OS
# detect, distro OS-prereqs, install Bun, land the repo — then hands off to
# `deploy/provision.ts` (run FROM the checkout), which finishes provisioning from
# the shared remediation table (src/remediations.ts).
#
# Operator-facing ops tooling like update.sh: plain English, NOT internationalized.
#
# Structure: the OS-decision + source-resolve logic live in small sourceable
# functions so a test can exercise the pure decisions without running the install:
#   SHEPHERD_INSTALL_LIB=1 source deploy/install.sh
# defines the functions but does NOT execute main (see the lib-mode guard at EOF).
#
# Environment contract:
#   SHEPHERD_SRC      Local source override: a tarball file (extracted into
#                     $SHEPHERD_DIR) or a directory (copied into $SHEPHERD_DIR).
#                     Used by the onboarding harness + local checkouts. When unset,
#                     the repo is git-cloned/updated.
#   SHEPHERD_REF      Git ref to clone/checkout (default: main).
#   SHEPHERD_DIR      Install dir (default: ~/.shepherd/app — matches the systemd
#                     unit's WorkingDirectory). Colocated under the ~/.shepherd/
#                     state home (db, env, logs) so the whole install is self-contained.
#   SHEPHERD_NO_SERVICE  Passed through to provision.ts: skip the systemd unit.
#                        Set automatically on macOS (core-only mode).
#
# RAM floor: Claude Code's installer transiently needs ~2 GB RSS; hosts below ~3 GB
#   total RAM may OOM-kill the install. Add RAM or swap if the install fails.
#
# Test seams (override OS detection; never set in real use):
#   SHEPHERD_UNAME_S  Overrides `uname -s`.
#   SHEPHERD_UNAME_M  Overrides `uname -m`.
set -euo pipefail

REPO_URL="https://github.com/erwins-enkel/shepherd.git"
SHEPHERD_REF="${SHEPHERD_REF:-main}"
SHEPHERD_DIR="${SHEPHERD_DIR:-$HOME/.shepherd/app}"

# ── colored helpers (match update.sh) ─────────────────────────────────────────
note() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die() {
  printf '\033[31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

# ── OS detection ──────────────────────────────────────────────────────────────
# Sets OS_KIND (from uname -s) and ARCH (from uname -m). Honors the
# SHEPHERD_UNAME_S / SHEPHERD_UNAME_M test seams.
detect_os() {
  OS_KIND="${SHEPHERD_UNAME_S:-$(uname -s)}"
  ARCH="${SHEPHERD_UNAME_M:-$(uname -m)}"
}

# ── mode decision ─────────────────────────────────────────────────────────────
# Maps OS_KIND to MODE: linux → full; darwin → core-only (degraded, no systemd);
# Windows-ish → refuse with a WSL2 message. Echoes "mode: <MODE>" so the chosen
# mode is observable to a test.
decide() {
  case "$OS_KIND" in
    Linux)
      MODE="full"
      ;;
    Darwin)
      MODE="core-only"
      export SHEPHERD_NO_SERVICE=1
      # The authoritative degraded-capability list lives in provision.ts
      # (macosDegradedBanner) — the layer that actually proceeds core-only and
      # prints it. Keep this to a one-liner so the two don't drift.
      warn "macOS detected → core-only / DEGRADED mode (no systemd unit); details below."
      ;;
    MINGW* | MSYS* | CYGWIN* | Windows*)
      die "Native Windows is not supported. Install Shepherd inside WSL2 (a Linux distro under Windows Subsystem for Linux), then re-run this installer from the WSL2 shell."
      ;;
    *)
      die "Unsupported OS '$OS_KIND'. Shepherd supports Linux (full) and macOS (core-only)."
      ;;
  esac
  echo "mode: $MODE"
}

# ── privilege helper ──────────────────────────────────────────────────────────
# Echoes the prefix needed to run a system package manager: empty when root,
# "sudo" when sudo is available, else dies with a clear manual-install message.
# $* = the packages we are about to install (named in the error).
sudo_prefix() {
  if [ "$(id -u)" = "0" ]; then
    printf ''
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    printf 'sudo'
    return 0
  fi
  die "Not running as root and 'sudo' is not available. Install these packages manually, then re-run: $*"
}

# ── OS prereqs ────────────────────────────────────────────────────────────────
# Cross-distro install of the bootstrap prereqs. Mirrors ci/onboarding-harness/
# seed.ts: curl, git, unzip (bun's installer hard-requires it) and a C/C++
# toolchain + python3 (node-pty has no prebuilt for every runtime → bun install
# compiles it via node-gyp). Each guarded with `command -v` so it's idempotent.
install_os_prereqs() {
  # bin → package name (cc/make share the toolchain installer below)
  ensure_pkg curl curl
  ensure_pkg git git
  ensure_pkg unzip unzip
  ensure_toolchain
  # The log-rotation timer (#1212) is self-contained (deploy/rotate-shepherd-log.sh, coreutils +
  # gzip — both baseline) — no external `logrotate` package to install here anymore.
}

# arch_keyring_refresh: on Arch only, refresh the drifted `archlinux-keyring` ONCE so the
# pacman branch below doesn't fail "unknown trust / invalid or corrupted package (PGP
# signature)" on a fresh image (#1422). Mirrors seed.ts archKeyringRefresh(). LAZY —
# callers invoke it only after their `command -v` early-return, i.e. only when an install
# is genuinely pending, so an all-prereqs-present Arch host never runs it. Memoized via
# `_arch_keyring_done` (set in this parent shell; only the privileged sync is a `$sp sh -c`
# subshell) so N missing prereqs trigger ONE sync, not N. No-op (returns 0) off pacman.
_arch_keyring_done=0
arch_keyring_refresh() {
  command -v pacman >/dev/null 2>&1 || return 0
  [ "$_arch_keyring_done" = 1 ] && return 0
  local sp
  sp="$(sudo_prefix "archlinux-keyring")"
  note "refreshing Arch package-signing keyring (archlinux-keyring)"
  $sp sh -c "pacman-key --init && pacman-key --populate archlinux && pacman -Sy --needed --noconfirm archlinux-keyring" \
    || die "failed to refresh the Arch keyring (pacman-key/archlinux-keyring)"
  _arch_keyring_done=1
}

# ensure_pkg <bin> <pkg>: install <pkg> via apt/apk/dnf/pacman if <bin> is absent.
ensure_pkg() {
  local bin="$1" pkg="$2" sp
  command -v "$bin" >/dev/null 2>&1 && return 0
  arch_keyring_refresh
  sp="$(sudo_prefix "$pkg")"
  note "installing $pkg (provides '$bin')"
  $sp sh -c "(apt-get update && apt-get install -y $pkg) || apk add --no-cache $pkg || dnf install -y $pkg || pacman -Sy --noconfirm $pkg" \
    || die "failed to install '$pkg' with any supported package manager (apt/apk/dnf/pacman)"
}

# ensure_toolchain: a C/C++ compiler + make + python3 for node-gyp's node-pty build.
ensure_toolchain() {
  local sp
  command -v cc >/dev/null 2>&1 && command -v make >/dev/null 2>&1 && return 0
  arch_keyring_refresh
  sp="$(sudo_prefix "build-essential/base-devel + python3")"
  note "installing C/C++ build toolchain + python3 (node-pty native build)"
  $sp sh -c "(apt-get update && apt-get install -y build-essential python3) || apk add --no-cache build-base python3 || dnf install -y gcc-c++ make python3 || pacman -Sy --noconfirm base-devel python3" \
    || die "failed to install a C/C++ toolchain + python3 with any supported package manager"
}

# ── Bun ───────────────────────────────────────────────────────────────────────
# Install Bun (idempotent — its installer no-ops when current) and put ~/.bun/bin
# on PATH for the rest of this script. Transparency: echo the third-party command
# before running it.
install_bun() {
  if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
    note "installing Bun via: curl -fsSL https://bun.sh/install | bash"
    curl -fsSL https://bun.sh/install | bash || die "Bun install failed"
  else
    note "Bun already present — skipping"
  fi
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "bun not on PATH after install (expected ~/.bun/bin/bun)"
}

# ── source resolve ────────────────────────────────────────────────────────────
# Populate $SHEPHERD_DIR with the repo. Precedence:
#   1. SHEPHERD_SRC set → tarball (extract) or directory (copy).
#   2. $SHEPHERD_DIR is an existing Shepherd checkout → update NON-DESTRUCTIVELY
#      (mirrors update.sh): a dirty tree is left untouched; a clean tree is
#      fast-forwarded only — never reset/--hard, never discarding work.
#   3. $SHEPHERD_DIR exists but is NOT a Shepherd checkout → abort (never clobber).
#   4. else → git clone the repo at $SHEPHERD_REF.
# Never touches an existing ~/.shepherd/ state dir.
resolve_source() {
  if [ -n "${SHEPHERD_SRC:-}" ]; then
    resolve_from_src
    return 0
  fi

  if [ -e "$SHEPHERD_DIR" ]; then
    if is_shepherd_checkout "$SHEPHERD_DIR"; then
      update_existing_checkout
    else
      die "$SHEPHERD_DIR exists but is not a Shepherd checkout — refusing to clobber it. Set SHEPHERD_DIR to an empty/new path, or remove it yourself."
    fi
    return 0
  fi

  note "cloning $REPO_URL (ref: $SHEPHERD_REF) into $SHEPHERD_DIR"
  git clone --branch "$SHEPHERD_REF" "$REPO_URL" "$SHEPHERD_DIR" \
    || die "git clone failed"
}

# resolve_from_src: handle a SHEPHERD_SRC tarball or directory.
resolve_from_src() {
  local src="$SHEPHERD_SRC"
  if [ -f "$src" ]; then
    note "extracting source tarball $src into $SHEPHERD_DIR"
    mkdir -p "$SHEPHERD_DIR"
    tar -xf "$src" -C "$SHEPHERD_DIR" || die "failed to extract $src"
  elif [ -d "$src" ]; then
    if [ "$(cd "$src" && pwd -P)" = "$(cd "$SHEPHERD_DIR" 2>/dev/null && pwd -P || echo)" ]; then
      note "source dir is the install dir — using in place: $SHEPHERD_DIR"
    else
      note "copying source dir $src into $SHEPHERD_DIR"
      mkdir -p "$SHEPHERD_DIR"
      # copy contents (including dotfiles) without nesting under a subdir
      cp -a "$src/." "$SHEPHERD_DIR/" || die "failed to copy $src"
    fi
  else
    die "SHEPHERD_SRC='$src' is neither a file (tarball) nor a directory"
  fi
}

# update_existing_checkout: safely refresh the existing $SHEPHERD_DIR checkout.
# Non-destructive (mirrors update.sh's posture): a dirty tree is left exactly as
# the developer left it; a clean tree is fast-forwarded only. Never reset/--hard,
# so uncommitted changes and un-pushed commits are never discarded. Idempotent for
# the common already-current clean case. Hand-off then proceeds with this tree.
update_existing_checkout() {
  if [ -n "$(git -C "$SHEPHERD_DIR" status --porcelain 2>/dev/null)" ]; then
    warn "existing checkout in $SHEPHERD_DIR has uncommitted changes — leaving it as-is (not updating)"
    return 0
  fi
  note "updating existing checkout in $SHEPHERD_DIR (ref: $SHEPHERD_REF)"
  git -C "$SHEPHERD_DIR" fetch --tags origin "$SHEPHERD_REF" || die "git fetch failed in $SHEPHERD_DIR"
  git -C "$SHEPHERD_DIR" checkout "$SHEPHERD_REF" || die "git checkout '$SHEPHERD_REF' failed"
  # fast-forward only; if it can't (diverged / un-pushed commits), leave it be.
  git -C "$SHEPHERD_DIR" merge --ff-only "origin/$SHEPHERD_REF" 2>/dev/null \
    || warn "cannot fast-forward $SHEPHERD_REF (diverged or un-pushed commits) — leaving checkout as-is"
}

# is_shepherd_checkout <dir>: true iff <dir> is a git repo that looks like Shepherd
# (has deploy/provision.ts — our hand-off target).
is_shepherd_checkout() {
  local dir="$1"
  [ -d "$dir/.git" ] || git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || return 1
  [ -f "$dir/deploy/provision.ts" ]
}

# ── orchestration ─────────────────────────────────────────────────────────────
main() {
  detect_os
  note "Shepherd installer — OS: $OS_KIND ($ARCH)"
  decide

  # core-only (macOS) still needs prereqs + bun; only the systemd path is skipped
  # (handled downstream by SHEPHERD_NO_SERVICE in provision.ts).
  install_os_prereqs
  install_bun
  resolve_source

  cd "$SHEPHERD_DIR" || die "cannot cd into $SHEPHERD_DIR"
  # Mirror the systemd units' EnvironmentFile=-%h/.shepherd/env so any SHEPHERD_DB /
  # SHEPHERD_BACKUP_DIR override reaches provision via process.env — otherwise provision would
  # write the .backup-configured marker to the DEFAULT dir while the server (which DOES read the
  # env file) looks in the override dir, silently disabling staleness alerting (#1080).
  set -a
  [ -f "$HOME/.shepherd/env" ] && . "$HOME/.shepherd/env"
  set +a
  note "handing off to deploy/provision.ts (from $SHEPHERD_DIR)"
  exec bun run deploy/provision.ts
}

# ── lib-mode guard ────────────────────────────────────────────────────────────
# When sourced with SHEPHERD_INSTALL_LIB set, define functions but DO NOT run.
[ "${SHEPHERD_INSTALL_LIB:-}" ] || main "$@"
