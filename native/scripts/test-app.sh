#!/usr/bin/env bash
# Generates the Xcode project and runs the unit + UI test bundles.
# Usage: native/scripts/test-app.sh [-only-testing:ShepherdTests]
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../Apps/ShepherdMac" && pwd)"

command -v xcodegen >/dev/null 2>&1 || {
  echo "xcodegen not found. Install it with: brew install xcodegen" >&2
  exit 1
}

cd "$APP_DIR"
xcodegen generate
# ShepherdKit runs the OpenAPIGenerator build-tool plugin. Outside the Xcode UI
# there is nobody to click "Trust & Enable", so the plugin-validation step fails
# the build; -skipPackagePluginValidation is the non-interactive equivalent.
xcodebuild \
  -project Shepherd.xcodeproj \
  -scheme Shepherd \
  -configuration Debug \
  -destination 'platform=macOS' \
  -derivedDataPath .build \
  -skipPackagePluginValidation \
  "$@" \
  test
