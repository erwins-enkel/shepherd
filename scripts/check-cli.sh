#!/usr/bin/env bash
# The full Rust CLI gate (cli/), run by the `cli` job in .github/workflows/ci.yml.
# Local work uses targeted Cargo tests; the pre-push hook does not run this full gate.
#
# Deliberate local-only difference: a machine without cargo SKIPS (exit 0) instead of failing, so
# an explicit local full check remains optional without a Rust toolchain. In CI a missing
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
