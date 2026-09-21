#!/usr/bin/env bash
# Real Ed25519 round-trip, tamper rejection and embedded-key mismatch.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
cat > "$FIXTURE/fixture.swift" <<'SWIFT'
import CryptoKit
import Foundation
let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let key = Curve25519.Signing.PrivateKey()
let bytes = Data("test update archive".utf8)
let signature = try key.signature(for: bytes).base64EncodedString()
try bytes.write(to: directory.appendingPathComponent("update.zip"))
try Data("tampered archive".utf8).write(to: directory.appendingPathComponent("tampered.zip"))
for (name, publicKey) in [("valid", key.publicKey), ("wrong", Curve25519.Signing.PrivateKey().publicKey)] {
    let plist = try PropertyListSerialization.data(fromPropertyList:
        ["SUPublicEDKey": publicKey.rawRepresentation.base64EncodedString()], format: .xml, options: 0)
    try plist.write(to: directory.appendingPathComponent(name + ".plist"))
}
try Data("<rss><channel><item><enclosure sparkle:edSignature=\"\(signature)\" xmlns:sparkle=\"http://www.andymatuschak.org/xml-namespaces/sparkle\"/></item></channel></rss>".utf8)
    .write(to: directory.appendingPathComponent("appcast.xml"))
SWIFT
swift "$FIXTURE/fixture.swift" "$FIXTURE"
swift "$ROOT/verify-update.swift" "$FIXTURE/valid.plist" "$FIXTURE/update.zip" "$FIXTURE/appcast.xml"
if swift "$ROOT/verify-update.swift" "$FIXTURE/valid.plist" "$FIXTURE/tampered.zip" "$FIXTURE/appcast.xml"; then
  echo 'FAIL: accepted tampered archive' >&2; exit 1
fi
if swift "$ROOT/verify-update.swift" "$FIXTURE/wrong.plist" "$FIXTURE/update.zip" "$FIXTURE/appcast.xml"; then
  echo 'FAIL: accepted wrong embedded key' >&2; exit 1
fi
echo 'PASS: valid archive accepted; tampering and wrong key rejected'
