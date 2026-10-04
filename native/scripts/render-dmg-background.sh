#!/usr/bin/env bash
# Regenerate the committed 1x/2x artwork and Finder's single HiDPI TIFF.
set -euo pipefail
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
OUT="$SCRIPTS/dmg-assets"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
swiftc -module-cache-path "$TEMP/module-cache" "$SCRIPTS/render-dmg-background.swift" -o "$TEMP/render"
"$TEMP/render" "$OUT"
tiffutil -cathidpicheck "$OUT/background.png" "$OUT/background@2x.png" -out "$OUT/background.tiff"
