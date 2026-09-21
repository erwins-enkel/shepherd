#!/usr/bin/env bash
# Manual installer; the signed ZIP remains the only Sparkle enclosure.
# Usage: package-dmg.sh /path/Shepherd.app /output/Shepherd-BUILD.dmg
set -euo pipefail
APP="$1"
OUT="$2"
[[ ! -e "$OUT" ]] || { echo 'DMG output already exists' >&2; exit 1; }
codesign --verify --deep --strict "$APP"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Shepherd.app"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/Read me - Bitte lesen.txt" <<'TEXT'
Shepherd → Applications / Programme

Drag Shepherd.app onto Applications, then open Shepherd from Applications.
For only your account, copy it to ~/Applications instead.
If you open the app here, it will offer to install itself after your approval.
You can eject this disk image once the installed app is running.
Existing installations are never silently replaced by the app.
This beta is ad-hoc signed, not Apple-notarized; Gatekeeper may still block it.

Ziehe Shepherd.app auf Applications (Programme). Öffne Shepherd danach aus Programme.
Nur für dein Konto: Kopiere die App stattdessen nach ~/Applications.
Beim direkten Start hier bietet die App nach deiner Zustimmung die Installation an.
Sobald die installierte App läuft, kannst du dieses Image auswerfen.
Die App ersetzt vorhandene Installationen niemals stillschweigend.
Diese Beta ist ad-hoc signiert und nicht von Apple notarisiert; Gatekeeper kann sie blockieren.
TEXT
# The volume title keeps the instruction visible even without opening the readme.
hdiutil create -volname 'Shepherd → Applications (Programme)' -srcfolder "$STAGE" \
  -format UDZO -ov "$OUT"
hdiutil verify "$OUT"
