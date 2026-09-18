#!/usr/bin/env bash
# ui/messages/{en,de}.json -> Apps/ShepherdMac/Resources/Localizable.xcstrings
# Pass --check to fail instead of writing when the catalog is stale.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec bun "$ROOT/native/scripts/gen-strings.ts" "$@"
