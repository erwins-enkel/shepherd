#!/usr/bin/env bash
# Generates the Xcode project from project.yml and builds Shepherd.app.
# Usage: native/scripts/build-app.sh [Debug|Release]   (default: Release)
set -euo pipefail

CONFIG="${1:-Release}"
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
  -configuration "$CONFIG" \
  -destination 'platform=macOS' \
  -derivedDataPath .build \
  -skipPackagePluginValidation \
  build

echo
echo "Built: $APP_DIR/.build/Build/Products/$CONFIG/Shepherd.app"
