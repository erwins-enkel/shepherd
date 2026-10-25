#!/usr/bin/env bash
# Usage: caller-lock build-ios-app.sh [Debug|Release] [--for-testing]
# Run the entire script under the caller's native lock; never nest wrappers.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../Apps/ShepherdIOS" && pwd)"
CONFIG="${1:-Debug}"
[[ "$CONFIG" == Debug || "$CONFIG" == Release ]] || { echo 'UNMET: configuration must be Debug or Release' >&2; exit 1; }
# --for-testing also builds the test bundles, so `test-ios-app.sh --without-building` can run
# them without rebuilding. Only the host architecture: simulators run that one, and a generic
# destination would otherwise compile every file twice for a universal binary.
ACTION=(build)
case "${2:-}" in
  "") ;;
  --for-testing) ACTION=("ARCHS=$(uname -m)" build-for-testing) ;;
  *) echo 'UNMET: unknown build argument' >&2; exit 1 ;;
esac
SIGNING=(CODE_SIGNING_ALLOWED=NO)
# Xcode 27 simulator hosts may refuse an unsigned runner. The same local opt-in as
# test-ios-app.sh; it must reach this build, since `--without-building` signs nothing.
if [[ "${SHEPHERD_IOS_SIMULATOR_SIGNING:-0}" == 1 ]]; then
  SIGNING=(CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=-)
fi
command -v xcodegen >/dev/null || { echo 'UNMET: xcodegen is required' >&2; exit 1; }
cd "$APP_DIR"
xcodegen generate
# Resolve packages without a github.com Keychain prompt (#2694): netrc instead
# of the Keychain authorizes binary-artifact downloads, and the system git only
# asks a credential helper after a 401, which public repositories never send.
xcodebuild -project ShepherdIOS.xcodeproj -scheme ShepherdIOS -configuration "$CONFIG" \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath .build \
  -skipPackagePluginValidation -packageAuthorizationProvider netrc -scmProvider system \
  "${SIGNING[@]}" "${ACTION[@]}" 2>&1 | tail -n 40
