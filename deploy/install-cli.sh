#!/usr/bin/env bash
# Install (or refresh) the prebuilt `shepherd` CLI at the server's version. #2484
#
#   deploy/install-cli.sh             # version from this checkout's package.json
#   deploy/install-cli.sh 1.48.0      # explicit version
#
# Called by install.sh (cold start) and update.sh (every deploy), which keeps the CLI in lockstep
# with the server. Both callers SOFT-fail on a non-zero exit: a version with no published binary
# (dev checkout, release still building, pre-CLI release) must never break an install or deploy.
#
# Idempotent: when the installed binary already reports this version, nothing is downloaded.
# Assets come from the separate `cli-v<ver>` GitHub release (.github/workflows/cli-release.yml —
# the main release is immutable, so binaries can't be attached to it). Each binary is verified
# against its published .sha256 before an atomic rename over the old one.
#
# Operator-facing ops tooling like update.sh: plain English, NOT internationalized.
#
# Environment:
#   SHEPHERD_CLI_DIR       Install dir (default: ~/.local/bin, where herdr lands too).
#   SHEPHERD_CLI_BASE_URL  Release download base (default: this repo's GitHub releases).
#                          Test seam — a file:// URL works.
#   SHEPHERD_NO_CLI        When set, skip entirely (exit 0).
#   SHEPHERD_UNAME_S/_M    Override `uname -s` / `uname -m` (test seams).
#   SHEPHERD_INSTALL_LIB   When set, define functions only (sourceable by tests).
set -euo pipefail

note() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die() {
  printf '\033[31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

# cli_target: echo the Rust target triple for this host, or nothing when no prebuilt exists.
cli_target() {
  local os="${SHEPHERD_UNAME_S:-$(uname -s)}" arch="${SHEPHERD_UNAME_M:-$(uname -m)}"
  case "$os/$arch" in
    Linux/x86_64 | Linux/amd64) echo "x86_64-unknown-linux-gnu" ;;
    Linux/aarch64 | Linux/arm64) echo "aarch64-unknown-linux-gnu" ;;
    Darwin/arm64 | Darwin/aarch64) echo "aarch64-apple-darwin" ;;
    *) echo "" ;;
  esac
}

# package_version <package.json>: the top-level "version" field.
package_version() {
  sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$1" | head -n1
}

# sha256 of a file as bare hex (Linux: sha256sum; macOS: shasum -a 256).
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Globals (not locals) so the EXIT trap can still see them after main returns.
CLI_TMP=""
CLI_SUM=""

main() {
  local repo version target dir dest base asset expected
  if [ -n "${SHEPHERD_NO_CLI:-}" ]; then
    note "SHEPHERD_NO_CLI set — skipping shepherd CLI install"
    return 0
  fi
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  version="${1:-$(package_version "$repo/package.json")}"
  # Validated before it reaches a URL or a path.
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] \
    || die "invalid CLI version '$version'"

  target="$(cli_target)"
  if [ -z "$target" ]; then
    warn "no prebuilt shepherd CLI for this platform — build it with: cargo install --path cli"
    return 0
  fi

  dir="${SHEPHERD_CLI_DIR:-$HOME/.local/bin}"
  dest="$dir/shepherd"
  if [ -x "$dest" ] && [ "$("$dest" --version 2>/dev/null || true)" = "shepherd $version" ]; then
    note "shepherd CLI already at $version ($dest)"
    return 0
  fi

  base="${SHEPHERD_CLI_BASE_URL:-https://github.com/erwins-enkel/shepherd/releases/download}"
  asset="shepherd-$target"
  note "installing shepherd CLI $version ($target) into $dir"
  mkdir -p "$dir"
  # Same dir as dest so the final mv is an atomic rename; removed on every exit path.
  trap 'rm -f "$CLI_TMP" "$CLI_SUM"' EXIT
  CLI_TMP="$(mktemp "$dir/.shepherd.XXXXXX")"
  CLI_SUM="$(mktemp "$dir/.shepherd.sha256.XXXXXX")"

  curl -fsSL --retry 2 -o "$CLI_TMP" "$base/cli-v$version/$asset" \
    || die "download failed: $base/cli-v$version/$asset (not published for $version?)"
  curl -fsSL --retry 2 -o "$CLI_SUM" "$base/cli-v$version/$asset.sha256" \
    || die "checksum download failed: $base/cli-v$version/$asset.sha256"
  expected="$(cut -d' ' -f1 <"$CLI_SUM")"
  [ "$(sha256_file "$CLI_TMP")" = "$expected" ] || die "checksum mismatch for $asset — not installed"

  chmod 755 "$CLI_TMP"
  mv -f "$CLI_TMP" "$dest"
  note "installed $("$dest" --version 2>/dev/null || echo "shepherd $version") at $dest"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) warn "$dir is not on PATH — add it to use \`shepherd\`" ;;
  esac
}

[ "${SHEPHERD_INSTALL_LIB:-}" ] || main "$@"
