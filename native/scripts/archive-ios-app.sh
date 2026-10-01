#!/usr/bin/env bash
# CI-only signing. Caller owns the native lock; dry-run export is the default.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../Apps/ShepherdIOS" && pwd)"
fail() { echo "::error::UNMET: $*" >&2; exit 1; }
[[ "${1:-Release}" == Release ]] || fail 'only Release archives are distributable'
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == macOS ]] || fail 'signing is restricted to macOS GitHub Actions'
for name in APPLE_TEAM_ID ASC_KEY_ID ASC_ISSUER_ID SHEPHERD_IOS_AUTH_KEY_PATH SHEPHERD_IOS_EXPORT_OPTIONS SHEPHERD_IOS_BUILD_NUMBER SHEPHERD_IOS_VERSION; do
  [[ -n "${!name:-}" ]] || fail "required signing/export input $name is absent"
done
[[ -f "$SHEPHERD_IOS_AUTH_KEY_PATH" ]] || fail 'authentication key file is absent'
[[ "$(stat -f '%Lp' "$SHEPHERD_IOS_AUTH_KEY_PATH")" == 600 ]] || fail 'authentication key must have mode 600'
DRY_RUN="${SHEPHERD_IOS_DRY_RUN:-true}"
[[ "$DRY_RUN" == true || "$DRY_RUN" == false ]] || fail 'dry_run must be true or false'
python3 - "$SHEPHERD_IOS_EXPORT_OPTIONS" "$APPLE_TEAM_ID" "$DRY_RUN" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as source:
    options = plistlib.load(source)
destination = 'export' if sys.argv[3] == 'true' else 'upload'
if (options.get('method') != 'app-store-connect' or options.get('destination') != destination
        or options.get('teamID') != sys.argv[2] or options.get('testFlightInternalTestingOnly', False)
        or options.get('signingStyle') != 'automatic'
        or options.get('manageAppVersionAndBuildNumber') is not False
        or 'provisioningProfiles' in options):
    sys.exit('::error::UNMET: export options disagree with automatic signing/dry-run policy')
PY
command -v xcodegen >/dev/null || fail 'xcodegen is required'
ARCHIVE="${SHEPHERD_IOS_ARCHIVE_PATH:-$RUNNER_TEMP/ShepherdIOS.xcarchive}"
EXPORT="${SHEPHERD_IOS_EXPORT_PATH:-$RUNNER_TEMP/ios-export}"
[[ ! -e "$ARCHIVE" && ! -e "$EXPORT" ]] || fail 'choose fresh archive/export paths'
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$SHEPHERD_IOS_AUTH_KEY_PATH"
  -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
cd "$APP_DIR"
xcodegen generate
xcodebuild -project ShepherdIOS.xcodeproj -scheme ShepherdIOS -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  -derivedDataPath "$RUNNER_TEMP/ios-derived-data" -skipPackagePluginValidation \
  "${AUTH[@]}" CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES CODE_SIGN_STYLE=Automatic \
  "DEVELOPMENT_TEAM=$APPLE_TEAM_ID" "MARKETING_VERSION=$SHEPHERD_IOS_VERSION" \
  "CURRENT_PROJECT_VERSION=$SHEPHERD_IOS_BUILD_NUMBER" archive 2>&1 | tail -n 40
"$SCRIPT_DIR/validate-ios-archive.sh" "$ARCHIVE" --archive-only "$SHEPHERD_IOS_EXPORT_OPTIONS"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT" \
  -exportOptionsPlist "$SHEPHERD_IOS_EXPORT_OPTIONS" "${AUTH[@]}" 2>&1 | tail -n 40
if [[ "$DRY_RUN" == true ]]; then
  "$SCRIPT_DIR/validate-ios-archive.sh" "$ARCHIVE" "$EXPORT" "$SHEPHERD_IOS_EXPORT_OPTIONS"
else
  echo 'App Store Connect upload completed; processing and TestFlight availability must be checked separately.'
fi
