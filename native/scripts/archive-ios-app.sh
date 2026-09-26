#!/usr/bin/env bash
# Caller owns the native lock. This command never uploads or changes keychains.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../Apps/ShepherdIOS" && pwd)"
CONFIG="${1:-Release}"
[[ "$CONFIG" == Release ]] || { echo 'UNMET: only Release archives are distributable' >&2; exit 1; }
for name in SHEPHERD_IOS_TEAM_ID SHEPHERD_IOS_SIGNING_IDENTITY SHEPHERD_IOS_PROFILE SHEPHERD_IOS_EXPORT_OPTIONS SHEPHERD_IOS_EXPORT_COMPLIANCE; do
  [[ -n "${!name:-}" ]] || { echo "UNMET: required signing/export input $name is absent" >&2; exit 1; }
done
[[ "$SHEPHERD_IOS_EXPORT_COMPLIANCE" == YES || "$SHEPHERD_IOS_EXPORT_COMPLIANCE" == NO ]] || { echo 'UNMET: export compliance must explicitly be YES or NO' >&2; exit 1; }
[[ -f "$SHEPHERD_IOS_EXPORT_OPTIONS" ]] || { echo 'UNMET: export-options file does not exist' >&2; exit 1; }
python3 - "$SHEPHERD_IOS_EXPORT_OPTIONS" "$SHEPHERD_IOS_TEAM_ID" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as source:
    options = plistlib.load(source)
if (options.get('method') != 'app-store-connect' or options.get('destination') != 'export'
        or options.get('teamID') != sys.argv[2] or options.get('testFlightInternalTestingOnly', False)
        or options.get('signingStyle') != 'manual'
        or not options.get('provisioningProfiles', {}).get('run.shepherd.ios')):
    sys.exit('UNMET: export options must specify local App Store Connect export and explicit manual signing')
PY
command -v xcodegen >/dev/null || { echo 'UNMET: xcodegen is required' >&2; exit 1; }
ARCHIVE="${SHEPHERD_IOS_ARCHIVE_PATH:-$APP_DIR/.build/ShepherdIOS.xcarchive}"
EXPORT="${SHEPHERD_IOS_EXPORT_PATH:-$APP_DIR/.build/export}"
[[ ! -e "$ARCHIVE" && ! -e "$EXPORT" ]] || { echo 'UNMET: choose fresh archive/export paths' >&2; exit 1; }
cd "$APP_DIR"
xcodegen generate
xcodebuild -project ShepherdIOS.xcodeproj -scheme ShepherdIOS -configuration "$CONFIG" \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -skipPackagePluginValidation \
  CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES CODE_SIGN_STYLE=Manual \
  "DEVELOPMENT_TEAM=$SHEPHERD_IOS_TEAM_ID" "CODE_SIGN_IDENTITY=$SHEPHERD_IOS_SIGNING_IDENTITY" \
  "PROVISIONING_PROFILE_SPECIFIER=$SHEPHERD_IOS_PROFILE" \
  "INFOPLIST_KEY_ITSAppUsesNonExemptEncryption=$SHEPHERD_IOS_EXPORT_COMPLIANCE" archive 2>&1 | tail -n 40
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT" \
  -exportOptionsPlist "$SHEPHERD_IOS_EXPORT_OPTIONS" 2>&1 | tail -n 40
"$SCRIPT_DIR/validate-ios-archive.sh" "$ARCHIVE" "$EXPORT" "$SHEPHERD_IOS_EXPORT_OPTIONS"
