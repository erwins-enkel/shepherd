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

  /// Decodes the last request's body as loose JSON, so a test can assert on what actually went
  /// on the wire rather than on the Swift value that produced it.
  private func lastRequestJSON(_ server: FakeShepherdServer) throws -> [String: Any] {
    let body = try #require(server.requests().last?.body)
    return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
  }

  // MARK: - resume

  @Test("resume returns the session it resumed")
  func resume() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/resume", status: 200,
      json: try Fixtures.json(Fixtures.session(id: "s1")))
    #expect(try await makeClient(server).resume(sessionID: "s1").id == "s1")
  }

  @Test("resume's force default reaches the wire, not just the Swift value")
  func resumeSendsForce() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/resume", status: 200,
      json: try Fixtures.json(Fixtures.session(id: "s1")))
    let client = try makeClient(server)

    _ = try await client.resume(sessionID: "s1")

    #expect(try lastRequestJSON(server)["force"] as? Bool == true)
  }

  @Test(
    "resume maps every documented failure and an undocumented status",
    arguments: [
      (401, "unauthorized", nil, ShepherdError.unauthenticated),
      (409, "first_run_pending", nil, ShepherdError.firstRunPending),
      (409, "cannot resume", nil, ShepherdError.conflict(code: nil, message: "cannot resume")),
      (
        500, "boom", nil,
        ShepherdError.contractMismatch(
          route: "resumeSession", underlying: "undocumented status 500")
      ),
    ] as [(Int, String, String?, ShepherdError)]
  )
  func resumeFailures(_ c: (Int, String, String?, ShepherdError)) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/resume", status: c.0, json: try Fixtures.errorJSON(c.1, code: c.2))
    let client = try makeClient(server)

    await #expect(throws: c.3) { _ = try await client.resume(sessionID: "s1") }
  }

  // MARK: - rename

  @Test("rename reports whether the branch moved")
  func rename() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/rename", status: 200,
      json: try Fixtures.json(
        Components.Schemas.RenameResult(
          session: Fixtures.session(id: "s1"), branchRenamed: false)))

    let result = try await makeClient(server).rename(sessionID: "s1", name: "fresh name")
    #expect(result.branchRenamed == false)
    #expect(result.session.id == "s1")
  }

  @Test("rename's new name reaches the wire")
  func renameSendsName() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/rename", status: 200,
      json: try Fixtures.json(
        Components.Schemas.RenameResult(
          session: Fixtures.session(id: "s1"), branchRenamed: false)))
    let client = try makeClient(server)

    _ = try await client.rename(sessionID: "s1", name: "fresh name")

    #expect(try lastRequestJSON(server)["name"] as? String == "fresh name")
  }

  @Test(
    "rename maps every documented failure and an undocumented status",
    arguments: [
      (400, "name too long", nil, ShepherdError.badRequest("name too long")),
      (401, "unauthorized", nil, ShepherdError.unauthenticated),
      (404, "no such session", nil, ShepherdError.notFound),
      (409, "name_taken", nil, ShepherdError.conflict(code: nil, message: "name_taken")),
      (
        500, "boom", nil,
        ShepherdError.contractMismatch(
          route: "renameSession", underlying: "undocumented status 500")
      ),
    ] as [(Int, String, String?, ShepherdError)]
  )
  func renameFailures(_ c: (Int, String, String?, ShepherdError)) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/rename", status: c.0, json: try Fixtures.errorJSON(c.1, code: c.2))
    let client = try makeClient(server)

    await #expect(throws: c.3) {
      _ = try await client.rename(sessionID: "s1", name: "taken")
    }
  }

  // MARK: - amend

  @Test("amend records the amendment and reports whether it was steered")
  func amend() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let amendment = Components.Schemas.TaskAmendment(
      id: "am1", sessionId: "s1", text: "Also cover the admin route.",
      createdAt: 1_800_000_000_000, retractedAt: nil)
    server.stub(
      "POST", "/api/sessions/s1/amendments", status: 201,
      json: try Fixtures.json(
        Components.Schemas.AmendmentCreated(amendment: amendment, steered: true)))

    let created = try await makeClient(server).amend(
      sessionID: "s1", text: "Also cover the admin route.", steer: true)
    #expect(created.steered == true)
    #expect(created.amendment.retractedAt == nil)
  }

  @Test("amend's steer flag reaches the wire")
  func amendSendsSteer() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let amendment = Components.Schemas.TaskAmendment(
      id: "am1", sessionId: "s1", text: "text", createdAt: 1_800_000_000_000, retractedAt: nil)
    server.stub(
      "POST", "/api/sessions/s1/amendments", status: 201,
      json: try Fixtures.json(
        Components.Schemas.AmendmentCreated(amendment: amendment, steered: true)))
    let client = try makeClient(server)

    _ = try await client.amend(sessionID: "s1", text: "text", steer: true)

    #expect(try lastRequestJSON(server)["steer"] as? Bool == true)
  }

  @Test(
    "amend maps every documented failure and an undocumented status",
    arguments: [
      (400, "text must not be empty", nil, ShepherdError.badRequest("text must not be empty")),
      (401, "unauthorized", nil, ShepherdError.unauthenticated),
      (404, "no such session", nil, ShepherdError.notFound),
      (
        500, "boom", nil,
        ShepherdError.contractMismatch(
          route: "amendSession", underlying: "undocumented status 500")
      ),
    ] as [(Int, String, String?, ShepherdError)]
  )
  func amendFailures(_ c: (Int, String, String?, ShepherdError)) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/amendments", status: c.0,
      json: try Fixtures.errorJSON(c.1, code: c.2))
    let client = try makeClient(server)

    await #expect(throws: c.3) {
      _ = try await client.amend(sessionID: "s1", text: " ", steer: false)
    }
  }

  // MARK: - ready

  @Test("the ready toggle returns nothing on success")
  func ready() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("POST", "/api/sessions/s1/ready", status: 200, json: Data(#"{"ok":true}"#.utf8))
    try await makeClient(server).setReadyToMerge(sessionID: "s1", ready: true)
  }

  @Test(
    "ready maps every documented failure and an undocumented status",
    arguments: [
      (400, "bad ready value", nil, ShepherdError.badRequest("bad ready value")),
      (401, "unauthorized", nil, ShepherdError.unauthenticated),
      (404, "not found", nil, ShepherdError.notFound),
      (
        500, "boom", nil,
        ShepherdError.contractMismatch(
          route: "setSessionReady", underlying: "undocumented status 500")
      ),
    ] as [(Int, String, String?, ShepherdError)]
  )
  func readyFailures(_ c: (Int, String, String?, ShepherdError)) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/ready", status: c.0, json: try Fixtures.errorJSON(c.1, code: c.2))
    let client = try makeClient(server)

    await #expect(throws: c.3) {
      try await client.setReadyToMerge(sessionID: "s1", ready: true)
    }
  }

  // MARK: - relaunch

  @Test("relaunch returns the replacement and whether the original was archived")
  func relaunch() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/relaunch", status: 201,
      json: try Fixtures.json(
        Components.Schemas.RelaunchResult(
          session: Fixtures.session(id: "s2"), archived: true)))

    let result = try await makeClient(server).relaunch(sessionID: "s1")
    #expect(result.session.id == "s2")
    #expect(result.archived == true)
  }

  @Test(
    "relaunch maps every documented failure, including the upstream 502, and an undocumented status",
    arguments: [
      (
        400, "unknown override key", nil, ShepherdError.badRequest("unknown override key")
      ),
      (401, "unauthorized", nil, ShepherdError.unauthenticated),
      (404, "no such session", nil, ShepherdError.notFound),
      (
        409, "relaunch in progress", "in_progress",
        ShepherdError.conflict(code: "in_progress", message: "relaunch in progress")
      ),
      (502, "git exploded", nil, ShepherdError.upstreamFailure("git exploded")),
      (
        500, "boom", nil,
        ShepherdError.contractMismatch(
          route: "relaunchSession", underlying: "undocumented status 500")
      ),
    ] as [(Int, String, String?, ShepherdError)]
  )
  func relaunchFailures(_ c: (Int, String, String?, ShepherdError)) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/relaunch", status: c.0,
      json: try Fixtures.errorJSON(c.1, code: c.2))
    let client = try makeClient(server)

    await #expect(throws: c.3) { _ = try await client.relaunch(sessionID: "s1") }
  }

  // MARK: - recap regenerate

  @Test("regenerate returns the status the server chose")
  func regenerate() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/recap/regenerate", status: 202,
      json: try Fixtures.json(
        Components.Schemas.RecapRegenerateResult(
          ok: true, status: RecapRegenerateStatus(known: .started))))

    let result = try await makeClient(server).regenerateRecap(sessionID: "s1")
    #expect(result.status.known == .started)
  }

  @Test(
    "regenerate maps every documented failure and an undocumented status",
    arguments: [
      (401, "unauthorized", nil, ShepherdError.unauthenticated),
      (404, "no such session", nil, ShepherdError.notFound),
      (
        500, "boom", nil,
        ShepherdError.contractMismatch(
          route: "regenerateRecap", underlying: "undocumented status 500")
      ),
    ] as [(Int, String, String?, ShepherdError)]
  )
  func regenerateFailures(_ c: (Int, String, String?, ShepherdError)) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/recap/regenerate", status: c.0,
      json: try Fixtures.errorJSON(c.1, code: c.2))
    let client = try makeClient(server)

    await #expect(throws: c.3) { _ = try await client.regenerateRecap(sessionID: "s1") }
  }

  // MARK: - recaps

  @Test("recaps decodes the map, and an unheard-of state and verdict survive as raw values")
  func recaps() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/recaps", status: 200,
      json: Data(
        #"{"s1":{"sessionId":"s1","state":"quantum","verdict":"needs_attention","headline":"h","body":"b","openItems":[],"updatedAt":7}}"#
          .utf8))

    let map = try await makeClient(server).recaps()
    #expect(map["s1"]?.state.known == nil)
    #expect(map["s1"]?.state.rawValue == "quantum")
    #expect(map["s1"]?.verdict?.known == .needsAttention)
    #expect(map["s1"]?.updatedAt == 7)
  }

  @Test(
    "recaps maps every documented failure and an undocumented status",
    arguments: [
      (401, "unauthorized", nil, ShepherdError.unauthenticated),
      (
        500, "boom", nil,
        ShepherdError.contractMismatch(route: "listRecaps", underlying: "undocumented status 500")
      ),
    ] as [(Int, String, String?, ShepherdError)]
  )
  func recapsFailures(_ c: (Int, String, String?, ShepherdError)) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/recaps", status: c.0, json: try Fixtures.errorJSON(c.1, code: c.2))
    let client = try makeClient(server)

    await #expect(throws: c.3) { _ = try await client.recaps() }
  }
}
