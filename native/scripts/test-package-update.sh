#!/usr/bin/env bash
# Package a disposable copy of a built app with a disposable signing key.
# Usage: test-package-update.sh /path/Shepherd.app /path/Sparkle/bin
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
ditto "$1" "$FIXTURE/Shepherd.app"
cat > "$FIXTURE/key.swift" <<'SWIFT'
import CryptoKit
import Foundation
let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let key = Curve25519.Signing.PrivateKey()
try Data(key.rawRepresentation.base64EncodedString().utf8).write(to: directory.appendingPathComponent("seed"))
let url = directory.appendingPathComponent("Shepherd.app/Contents/Info.plist")
var info = try PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as! [String: Any]
info["SUPublicEDKey"] = key.publicKey.rawRepresentation.base64EncodedString()
info["CFBundleVersion"] = "2"
info["CFBundleShortVersionString"] = "0.1.0"
try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: url)
SWIFT
swift "$FIXTURE/key.swift" "$FIXTURE"
codesign --force --sign - --options runtime "$FIXTURE/Shepherd.app"
export SPARKLE_PRIVATE_KEY="$(cat "$FIXTURE/seed")"
"$ROOT/package-update.sh" "$FIXTURE/Shepherd.app" "$FIXTURE/output" "$2" https://example.com/releases/test/
echo 'PASS: signed app archive and appcast generated and verified'
