#!/usr/bin/env bash
# Incremental simulator install. Run the entire script under uitest-lock.sh.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../Apps/ShepherdIOS" && pwd)"
DEVICE="iPhone 17 Pro"
OS=26.5
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) DEVICE="${2:?missing device name}"; shift 2 ;;
    --os) OS="${2:?missing OS version}"; shift 2 ;;
    -h|--help) echo 'Usage: ios-dev.sh [--device "iPhone 17 Pro"] [--os 26.5]'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done
command -v xcodegen >/dev/null || { echo 'xcodegen is required' >&2; exit 1; }
cd "$APP_DIR"
mkdir -p .build
# Regenerate for source additions/removals as well as spec changes. XcodeGen's
# file references are explicit; hashing only project.yml misses new Swift files.
SPEC_HASH="$(python3 -c '
import hashlib, pathlib
root = pathlib.Path(".")
stamp = hashlib.sha256((root / "project.yml").read_bytes())
for directory in ("Sources", "Tests", "UITests"):
    for path in sorted((root / directory).rglob("*")):
        if path.is_file():
            stamp.update(str(path).encode() + b"\0")
print(stamp.hexdigest())
')"
STAMP=.build/ios-dev-project.sha256
if [[ ! -f ShepherdIOS.xcodeproj/project.pbxproj || ! -f "$STAMP" || "$(cat "$STAMP")" != "$SPEC_HASH" ]]; then
  xcodegen generate
  printf '%s\n' "$SPEC_HASH" > "$STAMP"
fi
UDID="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
name, version = sys.argv[1:]
runtime = "com.apple.CoreSimulator.SimRuntime.iOS-" + version.replace(".", "-")
devices = [d for d in json.load(sys.stdin)["devices"].get(runtime, []) if d["name"] == name]
if not devices:
    raise SystemExit("No available " + name + " on iOS " + version)
devices.sort(key=lambda d: (d["state"] != "Booted", d["udid"]))
print(devices[0]["udid"])
' "$DEVICE" "$OS")"
# Resolve packages without a github.com Keychain prompt (#2694): netrc instead
# of the Keychain authorizes binary-artifact downloads, and the system git only
# asks a credential helper after a 401, which public repositories never send.
xcodebuild -project ShepherdIOS.xcodeproj -scheme ShepherdIOS -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath .build \
  -skipPackagePluginValidation -packageAuthorizationProvider netrc -scmProvider system \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY=- build 2>&1 | grep -E "error:|^\*\* BUILD"
STATE="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
print(next(d["state"] for ds in json.load(sys.stdin)["devices"].values() for d in ds if d["udid"] == sys.argv[1]))
' "$UDID")"
if [[ "$STATE" != Booted ]]; then xcrun simctl boot "$UDID"; fi
xcrun simctl bootstatus "$UDID" -b
APP=.build/Build/Products/Debug-iphonesimulator/ShepherdIOS.app
# Install in place: the app container, profiles and simulator Keychain survive.
xcrun simctl terminate "$UDID" run.shepherd.ios 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" run.shepherd.ios
