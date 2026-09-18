#!/usr/bin/env bash
# Copy contracts/openapi.swift.yaml into the ShepherdKit target.
#
# The SOURCE is the DERIVED contract (`bun run gen:contract-swift`), not the
# truth file: swift-openapi-generator cannot represent the const, null-in-enum
# and oneOf-with-null constructs the ajv drift test needs.
#
# swift-openapi-generator's build plugin looks for exactly one file named
# openapi.yaml / openapi.yml / openapi.json inside the target's own sources
# (it filters SwiftPM's `target.sourceFiles` by last path component), so the
# contract has to physically live next to openapi-generator-config.yaml.
#
#   ./native/scripts/sync-contract.sh          copy contracts/ -> native/
#   ./native/scripts/sync-contract.sh --check  fail if the copy is stale (CI)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
src="$repo_root/contracts/openapi.swift.yaml"
dst="$repo_root/native/Sources/ShepherdKit/openapi.yaml"

if [ ! -f "$src" ]; then
  echo "sync-contract: missing $src — run 'bun run gen:contract-swift' first" >&2
  exit 1
fi

if [ "${1:-}" = "--check" ]; then
  if [ ! -f "$dst" ]; then
    echo "sync-contract: missing $dst — run native/scripts/sync-contract.sh" >&2
    exit 1
  fi
  if ! diff -u "$src" "$dst"; then
    echo "sync-contract: native/Sources/ShepherdKit/openapi.yaml is stale." >&2
    echo "sync-contract: run native/scripts/sync-contract.sh and commit the result." >&2
    exit 1
  fi
  echo "sync-contract: up to date"
  exit 0
fi

cp "$src" "$dst"
echo "sync-contract: contracts/openapi.swift.yaml -> native/Sources/ShepherdKit/openapi.yaml"
