#!/usr/bin/env bash
# Verify a local signed candidate; no upload, security configuration or secrets.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../Apps/ShepherdIOS" && pwd)"
ARCHIVE="${1:-${SHEPHERD_IOS_ARCHIVE_PATH:-$APP_DIR/.build/ShepherdIOS.xcarchive}}"
EXPORT="${2:-${SHEPHERD_IOS_EXPORT_PATH:-$APP_DIR/.build/export}}"
OPTIONS="${3:-${SHEPHERD_IOS_EXPORT_OPTIONS:-}}"
[[ -d "$ARCHIVE" && -d "$EXPORT" && -f "$OPTIONS" ]] || { echo 'UNMET: archive, export and export options must exist' >&2; exit 1; }
APP="$ARCHIVE/Products/Applications/ShepherdIOS.app"
[[ -f "$APP/embedded.mobileprovision" ]] || { echo 'UNMET: signed provisioning profile is missing' >&2; exit 1; }
codesign --verify --deep --strict "$APP"
python3 - "$APP/Info.plist" "$OPTIONS" "$EXPORT" <<'PY'
import pathlib, plistlib, sys, zipfile
with open(sys.argv[1], 'rb') as source: info = plistlib.load(source)
with open(sys.argv[2], 'rb') as source: options = plistlib.load(source)
ipas = list(pathlib.Path(sys.argv[3]).glob('*.ipa'))
if len(ipas) != 1: sys.exit('UNMET: exactly one exported IPA is required')
if (info.get('CFBundleIdentifier') != 'run.shepherd.ios' or not info.get('CFBundleVersion')
        or not info.get('CFBundleShortVersionString') or set(info.get('UIDeviceFamily', [])) != {1, 2}
        or type(info.get('ITSAppUsesNonExemptEncryption')) is not bool):
    sys.exit('UNMET: archive identity, version, device families or export-compliance input is invalid')
if (options.get('method') != 'app-store-connect' or options.get('destination') != 'export'
        or options.get('testFlightInternalTestingOnly', False)):
    sys.exit('UNMET: candidate is not eligible for later external distribution')
with zipfile.ZipFile(ipas[0]) as ipa:
    names = [n for n in ipa.namelist() if n.startswith('Payload/') and n.count('/') == 2 and n.endswith('.app/Info.plist')]
    if len(names) != 1: sys.exit('UNMET: invalid IPA application inventory')
    exported = plistlib.loads(ipa.read(names[0]))
    for key in ('CFBundleIdentifier', 'CFBundleVersion', 'CFBundleShortVersionString', 'UIDeviceFamily'):
        if exported.get(key) != info.get(key): sys.exit('UNMET: exported IPA differs from archive')
print('Validated local archive/IPA; build=' + str(info['CFBundleVersion']) + '; upload not performed')
PY
