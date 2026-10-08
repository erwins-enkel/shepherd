#!/usr/bin/env bash
# Generates the Xcode project and runs the unit + UI test bundles.
# Usage: native/scripts/test-app.sh [-only-testing:ShepherdTests]
# A run with UI tests stops before building on a Mac whose UI Automation still
# asks for authentication; SHEPHERD_ALLOW_AUTOMATION_PROMPT=1 runs it anyway.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../Apps/ShepherdMac" && pwd)"

# Fills CODESIGN_ARGS and prints which signing mode this machine uses.
# shellcheck source=native/scripts/codesign-mode.sh
. "$SCRIPT_DIR/codesign-mode.sh"
shepherd_codesign_args
# Stops a run with UI tests that would wait on the "Enable UI Automation"
# dialog, before anything is unlocked, generated or built.
# shellcheck source=native/scripts/automation-mode.sh
. "$SCRIPT_DIR/automation-mode.sh"
shepherd_automation_preflight "$@" || exit 1
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

# Every automated launch of the app runs *isolated*: a private UserDefaults
# suite and an in-memory credential store instead of the operator's saved
# profiles and the login Keychain. Without it, launching the real bundle reads
# the real token, and `SecItemCopyMatching` blocks on a SecurityAgent dialog
# ("Shepherd möchte deine vertraulichen Informationen verwenden…") that an
# unattended run has nobody to answer.
#
# The UI bundle also passes `-ShepherdIsolated 1` on every `XCUIApplication`
# launch, because XCUITest does not forward this process's environment to the
# app under test; this is the belt to those braces. What it adds on its own is
# the *unit* bundle, whose host process IS the app: `TEST_RUNNER_` is the prefix
# xcodebuild strips on the way into a hosted test process, and `LaunchEnvironment`
# reads both spellings. Neither variable changes anything for a normal launch of
# the app from Finder.
export SHEPHERD_ISOLATED=1
export TEST_RUNNER_SHEPHERD_ISOLATED=1
# ShepherdKit runs the OpenAPIGenerator build-tool plugin. Outside the Xcode UI
# there is nobody to click "Trust & Enable", so the plugin-validation step fails
# the build; -skipPackagePluginValidation is the non-interactive equivalent.
# Resolve packages without a github.com Keychain prompt (#2694): netrc instead
# of the Keychain authorizes binary-artifact downloads, and the system git only
# asks a credential helper after a 401, which public repositories never send.
xcodebuild \
  -project Shepherd.xcodeproj \
  -scheme Shepherd \
  -configuration Debug \
  -destination 'platform=macOS' \
  -derivedDataPath .build \
  -skipPackagePluginValidation \
  -packageAuthorizationProvider netrc \
  -scmProvider system \
  "${CODESIGN_ARGS[@]+"${CODESIGN_ARGS[@]}"}" \
  "$@" \
  test
