#!/usr/bin/env bash
# Manual installer; the signed ZIP remains the only Sparkle enclosure.
# Usage: package-dmg.sh /path/Shepherd.app /output/Shepherd-BUILD.dmg
set -euo pipefail
[[ $# -eq 2 ]] || { echo 'Usage: package-dmg.sh /path/Shepherd.app /output/Shepherd-BUILD.dmg' >&2; exit 1; }
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
APP="$1"
OUT="$2"
[[ ! -e "$OUT" && ! -L "$OUT" ]] || { echo 'DMG output already exists' >&2; exit 1; }
codesign --verify --deep --strict "$APP"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
if [[ -z "${DMGBUILD:-}" ]]; then
  python3 -m venv "$STAGE/venv"
  "$STAGE/venv/bin/python" -m pip install --disable-pip-version-check --quiet 'dmgbuild==1.6.7'
  DMGBUILD="$STAGE/venv/bin/dmgbuild"
fi
# Keep the signed input isolated from the image builder.
ditto "$APP" "$STAGE/Shepherd.app"
"$DMGBUILD" -s "$SCRIPTS/dmg-settings.py" \
  -D "app=$STAGE/Shepherd.app" \
  -D "background=$SCRIPTS/dmg-assets/background.tiff" \
  Shepherd "$STAGE/Shepherd.dmg"
hdiutil verify "$STAGE/Shepherd.dmg"
# Publish only a verified image. -n also protects a concurrently created output.
cp -n "$STAGE/Shepherd.dmg" "$OUT"
cmp -s "$STAGE/Shepherd.dmg" "$OUT"
hdiutil verify "$OUT"
