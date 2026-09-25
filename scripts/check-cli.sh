#!/usr/bin/env bash
# The Rust CLI gate (cli/). The `cli` job in .github/workflows/ci.yml and the `cli` lane of
# scripts/pre-push.ts both run THIS script, so there is one command list.
#
# Deliberate local-only difference: a machine without cargo SKIPS (exit 0) instead of failing, so
# a contributor with no Rust toolchain is not blocked from pushing a contract edit. In CI a missing
# cargo is an error, never a skip.
#
# `--locked`: release-please bumps the crate version in BOTH Cargo.toml and Cargo.lock
# (release-please-config.json), so the committed lockfile is always current.
set -euo pipefail

cd "$(dirname "$0")/../cli"

if ! command -v cargo >/dev/null 2>&1; then
  if [ -n "${CI:-}" ]; then
    echo "cargo not found in CI" >&2
    exit 1
  fi
  echo "cargo not found — skipping the Rust CLI checks (CI runs them)."
  exit 0
fi

cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
