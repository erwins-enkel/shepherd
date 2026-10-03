#!/usr/bin/env bash
# CI-only signing. Caller owns the native lock; dry-run export is the default.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../Apps/ShepherdIOS" && pwd)"
fail() { echo "::error::UNMET: $*" >&2; exit 1; }
[[ "${1:-Release}" == Release ]] || fail 'only Release archives are distributable'
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == macOS ]] || fail 'signing is restricted to macOS GitHub Actions'
for name in APPLE_TEAM_ID SHEPHERD_IOS_PROFILE_UUID SHEPHERD_IOS_EXPORT_OPTIONS SHEPHERD_IOS_BUILD_NUMBER SHEPHERD_IOS_VERSION; do
  [[ -n "${!name:-}" ]] || fail "required signing/export input $name is absent"
done
DRY_RUN="${SHEPHERD_IOS_DRY_RUN:-true}"
[[ "$DRY_RUN" == true || "$DRY_RUN" == false ]] || fail 'dry_run must be true or false'
python3 - "$SHEPHERD_IOS_EXPORT_OPTIONS" "$APPLE_TEAM_ID" "$SHEPHERD_IOS_PROFILE_UUID" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as source:
    options = plistlib.load(source)
if (options.get('method') != 'app-store-connect' or options.get('destination') != 'export'
        or options.get('teamID') != sys.argv[2] or options.get('testFlightInternalTestingOnly', False)
        or options.get('signingStyle') != 'manual'
        or options.get('signingCertificate') != 'Apple Distribution'
        or options.get('manageAppVersionAndBuildNumber') is not False
        or options.get('provisioningProfiles') != {'run.shepherd.ios': sys.argv[3]}):
    sys.exit('::error::UNMET: export options disagree with manual signing policy')
PY
if [[ "$DRY_RUN" == false ]]; then
  for name in ASC_KEY_ID ASC_ISSUER_ID SHEPHERD_IOS_AUTH_KEY_PATH; do
    [[ -n "${!name:-}" ]] || fail "required upload input $name is absent"
  done
  [[ -f "$SHEPHERD_IOS_AUTH_KEY_PATH" ]] || fail 'authentication key file is absent'
  [[ "$(stat -f '%Lp' "$SHEPHERD_IOS_AUTH_KEY_PATH")" == 600 ]] || fail 'authentication key must have mode 600'
fi
command -v xcodegen >/dev/null || fail 'xcodegen is required'
ARCHIVE="${SHEPHERD_IOS_ARCHIVE_PATH:-$RUNNER_TEMP/ShepherdIOS.xcarchive}"
EXPORT="${SHEPHERD_IOS_EXPORT_PATH:-$RUNNER_TEMP/ios-export}"
[[ ! -e "$ARCHIVE" && ! -e "$EXPORT" ]] || fail 'choose fresh archive/export paths'
cd "$APP_DIR"
xcodegen generate --spec project-app-store.yml
# Fail closed if a future scheme edit adds another target to the archive action.
python3 - <<'PY'
import sys, xml.etree.ElementTree as ET
scheme = ET.parse('ShepherdIOS.xcodeproj/xcshareddata/xcschemes/ShepherdIOS.xcscheme')
targets = [entry.find('BuildableReference').get('BlueprintName')
           for entry in scheme.findall('.//BuildActionEntry') if entry.get('buildForArchiving') == 'YES']
if targets != ['ShepherdIOS']:
    sys.exit('::error::UNMET: archive scheme must build only the app target')
print('Archive targets: ShepherdIOS; test bundles remain unsigned and test-only.')
PY
# Resolve packages without a github.com Keychain prompt (#2694): netrc instead
# of the Keychain authorizes binary-artifact downloads, and the system git only
# asks a credential helper after a 401, which public repositories never send.
xcodebuild -project ShepherdIOS.xcodeproj -scheme ShepherdIOS -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  -derivedDataPath "$RUNNER_TEMP/ios-derived-data" -skipPackagePluginValidation \
  -packageAuthorizationProvider netrc -scmProvider system \
  "MARKETING_VERSION=$SHEPHERD_IOS_VERSION" \
  "CURRENT_PROJECT_VERSION=$SHEPHERD_IOS_BUILD_NUMBER" archive 2>&1 | tail -n 40
"$SCRIPT_DIR/validate-ios-archive.sh" "$ARCHIVE" --archive-only "$SHEPHERD_IOS_EXPORT_OPTIONS"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT" \
  -exportOptionsPlist "$SHEPHERD_IOS_EXPORT_OPTIONS" 2>&1 | tail -n 40
"$SCRIPT_DIR/validate-ios-archive.sh" "$ARCHIVE" "$EXPORT" "$SHEPHERD_IOS_EXPORT_OPTIONS"
if [[ "$DRY_RUN" == false ]]; then
  # Apple supports altool for App Store uploads (notarization is a separate service).
  API_PRIVATE_KEYS_DIR="$(dirname "$SHEPHERD_IOS_AUTH_KEY_PATH")" \
    xcrun altool --upload-app -f "$EXPORT/"*.ipa -t ios \
    --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" 2>&1 | tail -n 40
  echo 'App Store Connect upload completed; processing and TestFlight availability must be checked separately.'
fi
