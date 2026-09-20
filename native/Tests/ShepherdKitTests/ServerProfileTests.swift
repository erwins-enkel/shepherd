import Foundation
import Testing

@testable import ShepherdKit

@Suite("ServerProfile", .timeLimit(.minutes(1)))
struct ServerProfileTests {
  @Test("credentialKey defaults to the profile id")
  func defaultCredentialKey() {
    let id = UUID()
    let p = ServerProfile(
      id: id, name: "Mac", baseURL: URL(string: "http://localhost:7330")!, mode: .local)
    #expect(p.credentialKey == "profile.\(id.uuidString)")
  }

  @Test("https remote is accepted")
  func httpsRemoteAccepted() throws {
    try ServerProfile.requireSecureRemote(URL(string: "https://shepherd.example.com")!)
  }

  @Test("plain http to a public host is rejected")
  func plainHttpRejected() {
    #expect(throws: ServerProfileError.insecureRemoteURL("shepherd.example.com")) {
      try ServerProfile.requireSecureRemote(URL(string: "http://shepherd.example.com:7330")!)
    }
  }

  @Test(
    "loopback over http is accepted",
    arguments: ["http://localhost:7330", "http://127.0.0.1:7330", "http://[::1]:7330"])
  func loopbackAccepted(_ raw: String) throws {
    try ServerProfile.requireSecureRemote(URL(string: raw)!)
  }

  @Test("tailnet names over http are accepted")
  func tailnetAccepted() throws {
    try ServerProfile.requireSecureRemote(URL(string: "http://mac-mini.tail1234.ts.net:7330")!)
  }

  @Test("a ts.net suffix only counts on a label boundary")
  func tailnetSuffixNeedsALabelBoundary() {
    #expect(throws: ServerProfileError.insecureRemoteURL("evilts.net")) {
      try ServerProfile.requireSecureRemote(URL(string: "http://evilts.net")!)
    }
  }

  @Test("a fully-qualified tailnet name (trailing DNS root dot) is accepted")
  func tailnetFQDNAccepted() throws {
    try ServerProfile.requireSecureRemote(URL(string: "http://mini.tail1234.ts.net.:7330")!)
  }

  @Test("the whole 127.0.0.0/8 loopback block is accepted, not just 127.0.0.1")
  func loopbackIPv4BlockAccepted() throws {
    try ServerProfile.requireSecureRemote(URL(string: "http://127.0.0.2:7330")!)
  }

  @Test("the expanded IPv6 loopback form is accepted")
  func loopbackIPv6ExpandedFormAccepted() throws {
    try ServerProfile.requireSecureRemote(URL(string: "http://[0:0:0:0:0:0:0:1]:7330")!)
  }

  @Test("a non-http(s) scheme is rejected even on an otherwise-loopback host")
  func nonHTTPSchemeRejected() {
    #expect(throws: ServerProfileError.insecureRemoteURL("localhost")) {
      try ServerProfile.requireSecureRemote(URL(string: "ftp://localhost:7330")!)
    }
  }

  @Test("a schemeless URL is rejected")
  func schemelessRejected() {
    #expect(throws: ServerProfileError.insecureRemoteURL("localhost")) {
      try ServerProfile.requireSecureRemote(URL(string: "//localhost:7330")!)
    }
  }

  @Test("a hostless URL is rejected")
  func hostlessRejected() {
    #expect(throws: ServerProfileError.missingHost) {
      try ServerProfile.requireSecureRemote(URL(string: "http:///api")!)
    }
  }

  @Test("validated() only gates remote profiles")
  func localProfileSkipsThePolicy() throws {
    let local = ServerProfile(
      name: "This Mac", baseURL: URL(string: "http://localhost:7330")!, mode: .local)
    try local.validated()
    let remote = ServerProfile(
      name: "Box", baseURL: URL(string: "http://box.example.com")!, mode: .remote)
    #expect(throws: ServerProfileError.insecureRemoteURL("box.example.com")) {
      try remote.validated()
    }
  }

  @Test("round-trips through JSON")
  func codable() throws {
    let p = ServerProfile(name: "Mac", baseURL: URL(string: "https://a.ts.net")!, mode: .remote)
    let back = try JSONDecoder().decode(ServerProfile.self, from: JSONEncoder().encode(p))
    #expect(back == p)
  }
}
