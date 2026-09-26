#!/usr/bin/env bash
# Run the entire script under the caller's native lock; never nest wrappers.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../Apps/ShepherdIOS" && pwd)"
CONFIG="${1:-Debug}"
[[ "$CONFIG" == Debug || "$CONFIG" == Release ]] || { echo 'UNMET: configuration must be Debug or Release' >&2; exit 1; }
command -v xcodegen >/dev/null || { echo 'UNMET: xcodegen is required' >&2; exit 1; }
cd "$APP_DIR"
xcodegen generate
xcodebuild -project ShepherdIOS.xcodeproj -scheme ShepherdIOS -configuration "$CONFIG" \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath .build \
  -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -n 40
