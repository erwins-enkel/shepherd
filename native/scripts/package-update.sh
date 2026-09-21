#!/usr/bin/env bash
# Packages a built release and signs its appcast. Never publishes anything.
# Usage: package-update.sh /path/Shepherd.app /empty/output /path/Sparkle/bin https://.../download/TAG/
set -euo pipefail
APP="$1"
OUT="$2"
TOOLS="$3"
DOWNLOAD_URL="$4"
: "${SPARKLE_PRIVATE_KEY:?Set the Sparkle signing key (base64 private seed)}"
python3 - "$APP" "$OUT" "$DOWNLOAD_URL" <<'PY'
import base64, os, pathlib, plistlib, sys
app, out, url = sys.argv[1:]
with open(pathlib.Path(app) / 'Contents/Info.plist', 'rb') as f:
    info = plistlib.load(f)
assert len(base64.b64decode(info['SUPublicEDKey'], validate=True)) == 32, 'Missing public update key'
assert info['SUFeedURL'].startswith('https://'), 'HTTPS feed required'
assert url.startswith('https://') and url.endswith('/'), 'HTTPS download base must end in /'
assert str(info['CFBundleVersion']).isdigit(), 'Release build number must be numeric'
assert not pathlib.Path(out).exists() or not any(pathlib.Path(out).iterdir()), 'Output must be empty'
PY
mkdir -p "$OUT"
codesign --verify --deep --strict "$APP"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"
ARCHIVE="$OUT/Shepherd-$BUILD.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"
# stdin keeps the signing key out of argv, build logs and on-disk files.
printf '%s' "$SPARKLE_PRIVATE_KEY" | "$TOOLS/generate_appcast" \
  --ed-key-file - --download-url-prefix "$DOWNLOAD_URL" --maximum-deltas 0 "$OUT"
python3 - "$OUT/appcast.xml" "$ARCHIVE" <<'PY'
import pathlib, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1])
items = root.findall('./channel/item')
assert len(items) == 1, 'Expected exactly one release'
e = items[0].find('enclosure')
assert e is not None and e.get('{http://www.andymatuschak.org/xml-namespaces/sparkle}edSignature'), 'Missing update signature'
assert int(e.get('length')) == pathlib.Path(sys.argv[2]).stat().st_size
PY
swift "$(dirname "$0")/verify-update.swift" "$APP/Contents/Info.plist" "$ARCHIVE" "$OUT/appcast.xml"
