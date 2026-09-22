#!/usr/bin/env bash
# Usage: caller-lock test-ios-app.sh unit|ui|live [--family iPhone|iPad|DuoOuter|DuoInner] [--result-bundle-path PATH]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../Apps/ShepherdIOS" && pwd)"
MODE="${1:-unit}"
[[ $# -gt 0 ]] && shift
FAMILY=iPhone
RESULT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --family) FAMILY="${2:?missing family}"; shift 2 ;;
    --result-bundle-path) RESULT="${2:?missing result path}"; shift 2 ;;
    *) echo 'UNMET: unknown test argument' >&2; exit 1 ;;
  esac
done
case "$MODE" in
  unit) TARGET=ShepherdIOSTests; SOURCE="$APP_DIR/Tests"; SUITE="" ;;
  ui) TARGET=ShepherdIOSUITests; SOURCE="$APP_DIR/UITests"; SUITE=ShepherdIOSUITests
      [[ "$FAMILY" != DuoOuter && "$FAMILY" != DuoInner ]] || SUITE=ShepherdIOSDuoUITests ;;
  live) TARGET=ShepherdIOSUITests; SOURCE="$APP_DIR/UITests"; SUITE=ShepherdIOSLiveCleanupUITests
        [[ "${SHEPHERD_IOS_LIVE_HARNESS:-}" == 1 ]] || { echo 'UNMET: use live-ios-smoke.sh for live execution' >&2; exit 1; } ;;
  *) echo 'UNMET: choose unit, ui or live' >&2; exit 1 ;;
esac
unset SHEPHERD_KEYCHAIN_TESTS TEST_RUNNER_SHEPHERD_KEYCHAIN_TESTS
if [[ "$MODE" != live ]]; then
  unset SHEPHERD_LIVE_BASE_URL SHEPHERD_LIVE_PASSWORD TEST_RUNNER_SHEPHERD_LIVE_BASE_URL TEST_RUNNER_SHEPHERD_LIVE_PASSWORD
fi
export SHEPHERD_ISOLATED=1 TEST_RUNNER_SHEPHERD_ISOLATED=1
command -v xcodegen >/dev/null || { echo 'UNMET: xcodegen is required' >&2; exit 1; }
mkdir -p "$APP_DIR/.build/results"
if [[ -z "$RESULT" ]]; then RESULT="$APP_DIR/.build/results/$MODE-$FAMILY-$(date +%s)-$$.xcresult"; fi
[[ "$RESULT" == /* && ! -e "$RESULT" ]] || { echo 'UNMET: result bundle must be a new absolute path' >&2; exit 1; }
DEVICES="$(mktemp "${TMPDIR:-/private/tmp}/shepherd-ios-devices.XXXXXX")"
trap 'rm -f "$DEVICES"' EXIT
xcrun simctl list devices available -j > "$DEVICES"
UDID="$(python3 "$SCRIPT_DIR/select-ios-simulator.py" "$DEVICES" --family "$FAMILY")"
cd "$APP_DIR"
xcodegen generate
ONLY="$TARGET"
[[ -z "$SUITE" ]] || ONLY="$TARGET/$SUITE"
set +e
xcodebuild -project ShepherdIOS.xcodeproj -scheme ShepherdIOS -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath .build \
  -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1 \
  -only-testing:"$ONLY" -resultBundlePath "$RESULT" \
  -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO test 2>&1 | tail -n 40
TEST_STATUS=${PIPESTATUS[0]}
set -e
[[ -d "$RESULT" ]] || { echo 'UNMET: no test result bundle produced' >&2; exit 1; }
xcrun xcresulttool get test-results summary --path "$RESULT" > "$RESULT.summary.json"
xcrun xcresulttool get test-results tests --path "$RESULT" > "$RESULT.tests.json"
ARGS=("$RESULT.summary.json" "$RESULT.tests.json" --source-root "$SOURCE")
[[ -z "$SUITE" ]] || ARGS+=(--suite "$SUITE")
python3 "$SCRIPT_DIR/check-ios-results.py" "${ARGS[@]}"
exit "$TEST_STATUS"
