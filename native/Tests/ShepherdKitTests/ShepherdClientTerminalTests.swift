import Foundation
import Testing

@testable import ShepherdKit

@Suite("ShepherdClient terminal")
struct ShepherdClientTerminalTests {
  private func makeClient(_ server: FakeShepherdServer) throws -> ShepherdClient {
    let credentials = InMemoryCredentialStore(
      seed: ["k": StoredCredential(token: "shp_test", tokenId: "tok")])
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    return try ShepherdClient(
      profile: profile, credentials: credentials, urlSession: server.urlSession())
  }

  @Test("200 returns without throwing")
  func delivered() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/reply", status: 200, json: Data(#"{"ok":true}"#.utf8))
    let client = try makeClient(server)

    try await client.replySession(id: "s1", text: "go ahead")
  }

  @Test("the body is the contract's ReplyRequest")
  func sendsBody() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/reply", status: 200, json: Data(#"{"ok":true}"#.utf8))
    let client = try makeClient(server)

    try await client.replySession(id: "s1", text: "ship it")

    let body = try #require(server.requests().last?.body)
    let decoded = try JSONDecoder().decode([String: String].self, from: body)
    #expect(decoded == ["text": "ship it"])
  }

  @Test("404 is notFound — a stale session list is a normal caller mistake")
  func notFound() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/reply", status: 404,
      json: Data(#"{"error":"not found"}"#.utf8))
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.notFound) {
      try await client.replySession(id: "s1", text: "hi")
    }
  }

  @Test("401 is unauthenticated")
  func unauthorized() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/reply", status: 401,
      json: Data(#"{"error":"unauthorized"}"#.utf8))
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.unauthenticated) {
      try await client.replySession(id: "s1", text: "hi")
    }
  }

  @Test("400 carries the server's message")
  func badRequest() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/reply", status: 400,
      json: Data(#"{"error":"body must be {text: string}"}"#.utf8))
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.badRequest("body must be {text: string}")) {
      try await client.replySession(id: "s1", text: "")
    }
  }
}
