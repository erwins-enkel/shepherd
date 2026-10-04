#!/usr/bin/env bash
# Exercise the real read-only installer layout and the copied bundle signature.
# Usage: test-package-dmg.sh /path/Shepherd.app
set -euo pipefail
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$(mktemp -d)"
MOUNTED=false
cleanup() {
  if [[ "$MOUNTED" == true ]]; then
    hdiutil detach "$FIXTURE/mount" >/dev/null || return
  fi
  rm -rf "$FIXTURE"
}
trap cleanup EXIT
"$SCRIPTS/package-dmg.sh" "$1" "$FIXTURE/Shepherd.dmg"
mkdir "$FIXTURE/mount"
hdiutil attach "$FIXTURE/Shepherd.dmg" -readonly -nobrowse -mountpoint "$FIXTURE/mount" >/dev/null
MOUNTED=true
test "$(readlink "$FIXTURE/mount/Applications")" = /Applications
diskutil info -plist "$FIXTURE/mount" > "$FIXTURE/volume.plist"
test "$(/usr/libexec/PlistBuddy -c 'Print :VolumeName' "$FIXTURE/volume.plist")" = Shepherd
test -s "$FIXTURE/mount/.DS_Store"
test -s "$FIXTURE/mount/.VolumeIcon.icns"
test -s "$FIXTURE/mount/.background.tiff"
test ! -e "$FIXTURE/mount/Read me - Bitte lesen.txt"
ICON_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$FIXTURE/mount/Shepherd.app/Contents/Info.plist")"
[[ "$ICON_NAME" == *.icns ]] || ICON_NAME="$ICON_NAME.icns"
cmp "$FIXTURE/mount/.VolumeIcon.icns" "$FIXTURE/mount/Shepherd.app/Contents/Resources/$ICON_NAME"
test -s "$FIXTURE/mount/Shepherd.app/Contents/Resources/Assets.car"
codesign --verify --deep --strict "$FIXTURE/mount/Shepherd.app"
# Compile the same file-copy implementation used by the app, without launching
# Shepherd or touching any real installation/profile.
cat > "$FIXTURE/main.swift" <<'SWIFT'
import Foundation
try AppInstallation.copy(source: URL(fileURLWithPath: CommandLine.arguments[1]),
                         to: URL(fileURLWithPath: CommandLine.arguments[2]))
SWIFT
swiftc -module-cache-path "$FIXTURE/module-cache" \
  "$SCRIPTS/../Apps/ShepherdMac/Sources/App/AppInstallation.swift" \
  "$FIXTURE/main.swift" -o "$FIXTURE/install-test"
"$FIXTURE/install-test" "$FIXTURE/mount/Shepherd.app" "$FIXTURE/Installed/Shepherd.app"
ditto "$1" "$FIXTURE/Downloads/Shepherd.app"
"$FIXTURE/install-test" "$FIXTURE/Downloads/Shepherd.app" "$FIXTURE/UserApplications/Shepherd.app"
codesign --verify --deep --strict "$FIXTURE/UserApplications/Shepherd.app"
test -d "$FIXTURE/Downloads/Shepherd.app"
codesign --verify --deep --strict "$FIXTURE/Installed/Shepherd.app"
test -d "$FIXTURE/mount/Shepherd.app"
echo 'PASS: DMG layout and installer copies from read-only DMG and Downloads retain valid signatures and sources'
