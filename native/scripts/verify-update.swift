#!/usr/bin/env swift
import CryptoKit
import Foundation

// Verify with the key embedded in the shipped app, not with the signing key.
// This prevents a rotated/misconfigured CI secret from stranding every tester.
final class Enclosure: NSObject, XMLParserDelegate {
    var signature: String?
    func parser(_ parser: XMLParser, didStartElement elementName: String,
                namespaceURI: String?, qualifiedName qName: String?,
                attributes: [String: String]) {
        if elementName == "enclosure" { signature = attributes["sparkle:edSignature"] }
    }
}
let args = CommandLine.arguments
let plist = try PropertyListSerialization.propertyList(
    from: Data(contentsOf: URL(fileURLWithPath: args[1])), format: nil) as! [String: Any]
let key = try Curve25519.Signing.PublicKey(rawRepresentation:
    Data(base64Encoded: plist["SUPublicEDKey"] as! String)!)
let parser = XMLParser(contentsOf: URL(fileURLWithPath: args[3]))!
let enclosure = Enclosure()
parser.delegate = enclosure
guard parser.parse(), let encoded = enclosure.signature,
      let signature = Data(base64Encoded: encoded),
      key.isValidSignature(signature, for: try Data(contentsOf: URL(fileURLWithPath: args[2])))
else {
    fputs("Update archive signature does not match the app's embedded public key\n", stderr)
    exit(1)
}
print("Update archive verified against embedded public key")
