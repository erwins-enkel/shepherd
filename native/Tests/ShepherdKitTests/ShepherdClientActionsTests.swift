import Foundation
import Testing

@testable import ShepherdKit

@Suite("ShepherdClient session actions")
struct ShepherdClientActionsTests {
  private func makeClient(_ server: FakeShepherdServer) throws -> ShepherdClient {
    let credentials = InMemoryCredentialStore()
    try credentials.save(StoredCredential(token: "shp_test", tokenId: "tok"), for: "k")
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    return try ShepherdClient(
      profile: profile, credentials: credentials, urlSession: server.urlSession())
  }

  /// Encode-then-decode: every fixture is produced from the generated type, so it cannot
  /// disagree with the contract.
  private func json<T: Encodable>(_ value: T) throws -> Data { try JSONEncoder().encode(value) }

  @Test("resume returns the session it resumed")
  func resume() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/resume", status: 200, json: try json(Fixtures.session(id: "s1")))
    #expect(try await makeClient(server).resume(sessionID: "s1").id == "s1")
  }

  @Test("a refused resume is a conflict, not a silent no-op")
  func resumeRefused() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/resume", status: 409,
      json: Data(#"{"error":"cannot resume"}"#.utf8))
    await #expect(throws: ShepherdError.self) {
      _ = try await makeClient(server).resume(sessionID: "s1")
    }
  }

  @Test("rename reports whether the branch moved")
  func rename() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/rename", status: 200,
      json: try json(
        Components.Schemas.RenameResult(
          session: Fixtures.session(id: "s1"), branchRenamed: false)))

    let result = try await makeClient(server).rename(sessionID: "s1", name: "fresh name")
    #expect(result.branchRenamed == false)
    #expect(result.session.id == "s1")
  }

  @Test("a taken name surfaces the server's own sentence")
  func renameTaken() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/rename", status: 409,
      json: Data(#"{"error":"name_taken"}"#.utf8))
    await #expect(throws: ShepherdError.self) {
      _ = try await makeClient(server).rename(sessionID: "s1", name: "taken")
    }
  }

  @Test("amend records the amendment and reports whether it was steered")
  func amend() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let amendment = Components.Schemas.TaskAmendment(
      id: "am1", sessionId: "s1", text: "Also cover the admin route.",
      createdAt: 1_800_000_000_000, retractedAt: nil)
    server.stub(
      "POST", "/api/sessions/s1/amendments", status: 201,
      json: try json(
        Components.Schemas.AmendmentCreated(amendment: amendment, steered: true)))

    let created = try await makeClient(server).amend(
      sessionID: "s1", text: "Also cover the admin route.", steer: true)
    #expect(created.steered == true)
    #expect(created.amendment.retractedAt == nil)
  }

  @Test("an empty amendment is a bad request carrying the server's words")
  func amendRejected() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/amendments", status: 400,
      json: Data(#"{"error":"text must not be empty"}"#.utf8))
    await #expect(throws: ShepherdError.badRequest("text must not be empty")) {
      _ = try await makeClient(server).amend(sessionID: "s1", text: " ", steer: false)
    }
  }

  @Test("the ready toggle returns nothing but throws on 404")
  func ready() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("POST", "/api/sessions/s1/ready", status: 200, json: Data(#"{"ok":true}"#.utf8))
    server.stub(
      "POST", "/api/sessions/gone/ready", status: 404, json: Data(#"{"error":"not found"}"#.utf8))
    let client = try makeClient(server)

    try await client.setReadyToMerge(sessionID: "s1", ready: true)
    await #expect(throws: ShepherdError.notFound) {
      try await client.setReadyToMerge(sessionID: "gone", ready: true)
    }
  }

  @Test("relaunch returns the replacement and whether the original was archived")
  func relaunch() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/relaunch", status: 201,
      json: try json(
        Components.Schemas.RelaunchResult(
          session: Fixtures.session(id: "s2"), archived: true)))

    let result = try await makeClient(server).relaunch(sessionID: "s1")
    #expect(result.session.id == "s2")
    #expect(result.archived == true)
  }

  @Test("regenerate returns the status the server chose")
  func regenerate() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/recap/regenerate", status: 202,
      json: try json(
        Components.Schemas.RecapRegenerateResult(
          ok: true, status: RecapRegenerateStatus(known: .started))))

    let result = try await makeClient(server).regenerateRecap(sessionID: "s1")
    #expect(result.status.known == .started)
  }

  @Test("recaps decodes the map, and an unheard-of state survives as its raw value")
  func recaps() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/recaps", status: 200,
      json: Data(
        #"{"s1":{"sessionId":"s1","state":"quantum","headline":"h","body":"b","openItems":[],"updatedAt":7}}"#
          .utf8))

    let map = try await makeClient(server).recaps()
    #expect(map["s1"]?.state.known == nil)
    #expect(map["s1"]?.state.rawValue == "quantum")
    #expect(map["s1"]?.updatedAt == 7)
  }

  @Test("a 401 maps to unauthenticated on every action")
  func unauthorized() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let body = Data(#"{"error":"unauthorized"}"#.utf8)
    for (method, path) in [
      ("POST", "/api/sessions/s1/resume"), ("POST", "/api/sessions/s1/rename"),
      ("POST", "/api/sessions/s1/amendments"), ("POST", "/api/sessions/s1/ready"),
      ("POST", "/api/sessions/s1/relaunch"), ("POST", "/api/sessions/s1/recap/regenerate"),
      ("GET", "/api/recaps"),
    ] {
      server.stub(method, path, status: 401, json: body)
    }
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.unauthenticated) {
      _ = try await client.resume(sessionID: "s1")
    }
    await #expect(throws: ShepherdError.unauthenticated) {
      _ = try await client.rename(sessionID: "s1", name: "x")
    }
    await #expect(throws: ShepherdError.unauthenticated) {
      _ = try await client.amend(sessionID: "s1", text: "x", steer: false)
    }
    await #expect(throws: ShepherdError.unauthenticated) {
      try await client.setReadyToMerge(sessionID: "s1", ready: true)
    }
    await #expect(throws: ShepherdError.unauthenticated) {
      _ = try await client.relaunch(sessionID: "s1")
    }
    await #expect(throws: ShepherdError.unauthenticated) {
      _ = try await client.regenerateRecap(sessionID: "s1")
    }
    await #expect(throws: ShepherdError.unauthenticated) { _ = try await client.recaps() }
  }
}
