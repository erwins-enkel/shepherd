#!/usr/bin/env bash
# Generates the Xcode project from project.yml and builds Shepherd.app.
# Usage: native/scripts/build-app.sh [Debug|Release]   (default: Release)
set -euo pipefail

CONFIG="${1:-Release}"
if [ "$#" -gt 0 ]; then shift; fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../Apps/ShepherdMac" && pwd)"

# Fills CODESIGN_ARGS and prints which signing mode this machine uses.
# shellcheck source=native/scripts/codesign-mode.sh
. "$SCRIPT_DIR/codesign-mode.sh"
shepherd_codesign_args
# Unlocks the dev signing keychain, or stops right here. It is a no-op unless
# that identity was the one chosen above; when it WAS chosen and cannot be
# unlocked, failing now beats letting codesign hang on a password dialog.
shepherd_unlock_signing_keychain || exit 1

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
  "${CODESIGN_ARGS[@]+"${CODESIGN_ARGS[@]}"}" \
  "$@" \
  build

echo
echo "Built: $APP_DIR/.build/Build/Products/$CONFIG/Shepherd.app"
