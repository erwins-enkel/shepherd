#!/usr/bin/env bash
# Model-check the plan-gate spec with TLC (#4154). Downloads a pinned, sha256-verified
# tla2tools.jar into ~/.cache/tla on first run. Needs Java >= 11.
#   bash docs/spec/plan-gate/run-tlc.sh            # PlanGate.cfg (all invariants)
#   bash docs/spec/plan-gate/run-tlc.sh Other.cfg  # another config in this directory
set -euo pipefail

TLA_VERSION="1.8.0"
TLA_SHA256="fdffef247f563ef6edbfd44958d2a82db79e7564e07cb673262d896353fa6713"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tla"
JAR="$CACHE_DIR/tla2tools-$TLA_VERSION.jar"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${1:-PlanGate.cfg}"

verify() { echo "$TLA_SHA256  $1" | sha256sum --check --status; }

if [[ ! -f "$JAR" ]] || ! verify "$JAR"; then
  mkdir -p "$CACHE_DIR"
  tmp="$(mktemp "$CACHE_DIR/tla2tools.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  curl -fsSL -o "$tmp" \
    "https://github.com/tlaplus/tlaplus/releases/download/v$TLA_VERSION/tla2tools.jar"
  verify "$tmp" || { echo "tla2tools.jar sha256 mismatch" >&2; exit 1; }
  mv "$tmp" "$JAR"
fi

meta="$(mktemp -d)"
trap 'rm -rf "$meta"' EXIT
cd "$HERE"
java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -workers auto -deadlock -noGenerateSpecTE \
  -metadir "$meta" -config "$CFG" PlanGate.tla
