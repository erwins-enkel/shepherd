#!/usr/bin/env bash
# Build "Shepherd Dev" (run.shepherd.ios.dev, Debug, development-signed) and install it on a
# paired iPhone over USB or Wi-Fi. It sits next to the TestFlight app instead of replacing it.
# Run the entire script under uitest-lock.sh.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../Apps/ShepherdIOS" && pwd)"
TEAM="${SHEPHERD_IOS_TEAM:-3WSC8JG6J4}"
BUNDLE_ID="${SHEPHERD_IOS_DEV_BUNDLE_ID:-run.shepherd.ios.dev}"
DEVICE="${SHEPHERD_IOS_DEVICE:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) DEVICE="${2:?missing device UDID or name}"; shift 2 ;;
    -h|--help)
      echo 'Usage: ios-device.sh [--device <UDID|name>]'
      echo 'Signing: Xcode account by default; or an App Store Connect API key via'
      echo '  SHEPHERD_ASC_KEY_PATH, SHEPHERD_ASC_KEY_ID, SHEPHERD_ASC_ISSUER_ID.'
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done
command -v xcodegen >/dev/null || { echo 'xcodegen is required' >&2; exit 1; }
cd "$APP_DIR"
mkdir -p .build
# Same regeneration rule as ios-dev.sh: project.yml plus the source file list.
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
# The only paired physical iPhone unless --device picks one.
DEVICE="$(xcrun devicectl list devices --json-output /dev/stdout 2>/dev/null | python3 -c '
import json, sys
wanted = sys.argv[1]
devices = [d for d in json.load(sys.stdin)["result"]["devices"]
           if d.get("hardwareProperties", {}).get("reality") == "physical"
           and d.get("hardwareProperties", {}).get("platform") == "iOS"
           and d.get("connectionProperties", {}).get("pairingState") == "paired"]
if wanted:
    devices = [d for d in devices if wanted in (d["hardwareProperties"].get("udid"), d["deviceProperties"].get("name"))]
if len(devices) != 1:
    raise SystemExit("Expected exactly one paired iPhone%s, found %d. Pair it in DeviceHub first." % (" matching " + wanted if wanted else "", len(devices)))
print(devices[0]["hardwareProperties"]["udid"])
' "$DEVICE")"
AUTH=()
if [[ -n "${SHEPHERD_ASC_KEY_PATH:-}" ]]; then
  AUTH=(-authenticationKeyPath "$SHEPHERD_ASC_KEY_PATH"
        -authenticationKeyID "${SHEPHERD_ASC_KEY_ID:?SHEPHERD_ASC_KEY_ID is required with SHEPHERD_ASC_KEY_PATH}"
        -authenticationKeyIssuerID "${SHEPHERD_ASC_ISSUER_ID:?SHEPHERD_ASC_ISSUER_ID is required with SHEPHERD_ASC_KEY_PATH}")
fi
# Automatic signing registers the device and the dev bundle id on first use.
xcodebuild -project ShepherdIOS.xcodeproj -scheme ShepherdIOS -configuration Debug \
  -destination "platform=iOS,id=$DEVICE" -derivedDataPath .build/device \
  -skipPackagePluginValidation -packageAuthorizationProvider netrc -scmProvider system \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration ${AUTH[@]+"${AUTH[@]}"} \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" SHEPHERD_DISPLAY_NAME="Shepherd Dev" \
  build 2>&1 | grep -E "error:|^\*\* BUILD"
APP=.build/device/Build/Products/Debug-iphoneos/ShepherdIOS.app
# Install in place: the app container, saved servers and Keychain token survive.
xcrun devicectl device install app --device "$DEVICE" "$APP" >/dev/null
xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID" >/dev/null
echo "Installed and launched $BUNDLE_ID on $DEVICE"
