#!/usr/bin/env bash
# ui/messages/{en,de}.json -> Sources/ShepherdAppCore/Resources/Catalog/Localizable.xcstrings
#                              + en.lproj/Localizable.strings
#                              + de.lproj/Localizable.strings
# Pass --check to fail instead of writing when any of the three outputs is missing or stale.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec bun "$ROOT/native/scripts/gen-strings.ts" "$@"
