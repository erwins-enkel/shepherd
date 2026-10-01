#!/usr/bin/env bash
# Read-only inspection of archive/IPA signatures and nonsecret profile metadata.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../Apps/ShepherdIOS" && pwd)"
ARCHIVE="${1:-${SHEPHERD_IOS_ARCHIVE_PATH:-$APP_DIR/.build/ShepherdIOS.xcarchive}}"
EXPORT="${2:-${SHEPHERD_IOS_EXPORT_PATH:-$APP_DIR/.build/export}}"
OPTIONS="${3:-${SHEPHERD_IOS_EXPORT_OPTIONS:-}}"
[[ -d "$ARCHIVE" && -f "$OPTIONS" ]] || { echo '::error::UNMET: archive and export options must exist' >&2; exit 1; }
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
inspect_signature() {
  local app="$1" label="$2"
  [[ -f "$app/embedded.mobileprovision" ]] || { echo '::error::UNMET: provisioning profile missing' >&2; exit 1; }
  codesign --verify --deep --strict "$app"
  local signature
  signature=$(codesign -dv --verbose=4 "$app" 2>&1)
  echo "$signature" | grep -E 'Authority=|TeamIdentifier=|Identifier='
  [[ "$signature" == *'Authority=Apple Distribution:'* ]] || { echo '::error::UNMET: expected Apple Distribution signature' >&2; exit 1; }
  security cms -D -i "$app/embedded.mobileprovision" > "$TEMP_DIR/profile.plist"
  python3 - "$TEMP_DIR/profile.plist" "$OPTIONS" "$label" <<'PY'
import datetime, plistlib, sys
with open(sys.argv[1], 'rb') as f: profile = plistlib.load(f)
with open(sys.argv[2], 'rb') as f: options = plistlib.load(f)
team = options['teamID']
entitlements = profile.get('Entitlements', {})
if (profile.get('TeamIdentifier') != [team]
        or entitlements.get('application-identifier') != team + '.run.shepherd.ios'
        or profile['ExpirationDate'] <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)):
    sys.exit('::error::UNMET: provisioning team, application or expiry mismatch')
if (options.get('provisioningProfiles') != {'run.shepherd.ios': profile['UUID']}
        or entitlements.get('get-task-allow', False)
        or 'ProvisionedDevices' in profile or profile.get('ProvisionsAllDevices', False)):
    sys.exit('::error::UNMET: unexpected profile or not App Store distribution')
print(f"{sys.argv[3]} profile: {profile['Name']}; UUID={profile['UUID']}; expires={profile['ExpirationDate']}")
PY
}
APP="$ARCHIVE/Products/Applications/ShepherdIOS.app"
inspect_signature "$APP" archive
python3 - "$APP/Info.plist" "$OPTIONS" "$EXPORT" <<'PY'
import pathlib, plistlib, sys, zipfile
with open(sys.argv[1], 'rb') as source: info = plistlib.load(source)
with open(sys.argv[2], 'rb') as source: options = plistlib.load(source)
if (info.get('CFBundleIdentifier') != 'run.shepherd.ios' or not info.get('CFBundleVersion')
        or not info.get('CFBundleShortVersionString') or set(info.get('UIDeviceFamily', [])) != {1, 2}
        or info.get('ITSAppUsesNonExemptEncryption') is not False
        or info.get('CFBundleDisplayName') != 'Shepherd'
        or not info.get('CFBundleIcons', {}).get('CFBundlePrimaryIcon', {}).get('CFBundleIconName')):
    sys.exit('::error::UNMET: archive identity, icon, version, families or encryption declaration invalid')
if (options.get('method') != 'app-store-connect' or options.get('destination') != 'export'
        or options.get('testFlightInternalTestingOnly', False)
        or options.get('signingStyle') != 'manual'
        or options.get('signingCertificate') != 'Apple Distribution'
        or options.get('manageAppVersionAndBuildNumber') is not False):
    sys.exit('::error::UNMET: invalid App Store Connect export options')
if sys.argv[3] != '--archive-only':
    if options['destination'] != 'export': sys.exit('::error::UNMET: expected local export')
    ipas = list(pathlib.Path(sys.argv[3]).glob('*.ipa'))
    if len(ipas) != 1: sys.exit('::error::UNMET: exactly one exported IPA is required')
    with zipfile.ZipFile(ipas[0]) as ipa:
        names = [n for n in ipa.namelist() if n.startswith('Payload/') and n.count('/') == 2 and n.endswith('.app/Info.plist')]
        if len(names) != 1: sys.exit('::error::UNMET: invalid IPA application inventory')
        exported = plistlib.loads(ipa.read(names[0]))
        for key in ('CFBundleIdentifier', 'CFBundleVersion', 'CFBundleShortVersionString', 'UIDeviceFamily', 'ITSAppUsesNonExemptEncryption', 'CFBundleIcons'):
            if exported.get(key) != info.get(key): sys.exit('::error::UNMET: exported IPA differs from archive')
print('Validated metadata; version=' + str(info['CFBundleShortVersionString']) + '; build=' + str(info['CFBundleVersion']))
PY
if [[ "$EXPORT" != --archive-only ]]; then
  ditto -x -k "$EXPORT/"*.ipa "$TEMP_DIR/ipa"
  inspect_signature "$TEMP_DIR/ipa/Payload/ShepherdIOS.app" export
  echo 'Validated signed archive/IPA; upload not performed.'
fi
