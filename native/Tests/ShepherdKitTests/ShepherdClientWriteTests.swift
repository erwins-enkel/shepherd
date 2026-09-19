import Foundation
import Testing

@testable import ShepherdKit

@Suite("ShepherdClient writes")
struct ShepherdClientWriteTests {
  private func makeClient(_ server: FakeShepherdServer) throws -> ShepherdClient {
    let credentials = InMemoryCredentialStore(
      seed: ["k": StoredCredential(token: "shp_test", tokenId: "tok")])
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    return try ShepherdClient(
      profile: profile, credentials: credentials, urlSession: server.urlSession())
  }

  private func createRequest() -> CreateSessionRequest {
    CreateSessionRequest(repoPath: "/repos/demo", baseBranch: "main", prompt: "do the thing")
  }

  @Test("201 yields the created session")
  func created() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions", status: 201,
      json: try Fixtures.json(Fixtures.session(id: "new")))
    let client = try makeClient(server)

    #expect(try await client.createSession(createRequest()) == .created(Fixtures.session(id: "new")))
  }

  @Test("200 yields a held task instead of a session")
  func heldTask() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let held = HeldTask(held: true, id: "held-1", count: 3)
    server.stub("POST", "/api/sessions", status: 200, json: try Fixtures.json(held))
    let client = try makeClient(server)

    #expect(try await client.createSession(createRequest()) == .held(held))
  }

  @Test("the request body is the contract's CreateSessionRequest")
  func sendsRequestBody() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions", status: 201,
      json: try Fixtures.json(Fixtures.session(id: "new")))
    let client = try makeClient(server)

    _ = try await client.createSession(createRequest())
    let body = try #require(server.requests().last?.body)
    let decoded = try JSONDecoder().decode(CreateSessionRequest.self, from: body)
    #expect(decoded.repoPath == "/repos/demo")
    #expect(decoded.baseBranch == "main")
    #expect(decoded.prompt == "do the thing")
  }

  @Test("409 first_run_pending becomes firstRunPending")
  func firstRunPending() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions", status: 409,
      json: try Fixtures.errorJSON("first_run_pending"))
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.firstRunPending) {
      _ = try await client.createSession(createRequest())
    }
  }

  @Test("any other 409 keeps the server's error and code")
  func otherConflict() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions", status: 409,
      json: try Fixtures.errorJSON("name taken", code: "name_taken"))
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.conflict(code: "name_taken", message: "name taken")) {
      _ = try await client.createSession(createRequest())
    }
  }

  @Test(
    "400, 422 and 502 map to their own cases",
    arguments: [
      (400, "bad input"), (422, "no such ref"), (502, "git exploded"),
    ])
  func createFailures(_ pair: (Int, String)) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("POST", "/api/sessions", status: pair.0, json: try Fixtures.errorJSON(pair.1))
    let client = try makeClient(server)

    let expected: ShepherdError =
      switch pair.0 {
      case 400: .badRequest(pair.1)
      case 422: .unprocessable(pair.1)
      default: .upstreamFailure(pair.1)
      }
    await #expect(throws: expected) { _ = try await client.createSession(createRequest()) }
  }

  @Test("archive and interrupt succeed quietly")
  func archiveAndInterrupt() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "DELETE", "/api/sessions/a", status: 200,
      json: try Fixtures.json(Components.Schemas.Ok(ok: true)))
    server.stub(
      "POST", "/api/sessions/a/interrupt", status: 200,
      json: try Fixtures.json(Components.Schemas.Ok(ok: true)))
    let client = try makeClient(server)

    try await client.archiveSession(id: "a")
    try await client.interruptSession(id: "a")
    #expect(server.requests().map(\.method) == ["DELETE", "POST"])
  }

  @Test("interrupting an unknown session is notFound")
  func interruptNotFound() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/gone/interrupt", status: 404,
      json: try Fixtures.errorJSON("no such session"))
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.notFound) { try await client.interruptSession(id: "gone") }
  }

  @Test("putRepoRoot returns the stored root")
  func putRepoRoot() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "PUT", "/api/settings", status: 200,
      json: try Fixtures.json(
        Components.Schemas.RepoRootResponse(
          repoRoot: "/repos", repoRootDisplay: "~/repos")))
    let client = try makeClient(server)

    #expect(try await client.putRepoRoot("/repos").repoRootDisplay == "~/repos")
  }

  @Test("a rejected repo root is badRequest")
  func putRepoRootRejected() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("PUT", "/api/settings", status: 400, json: try Fixtures.errorJSON("not a directory"))
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.badRequest("not a directory")) {
      _ = try await client.putRepoRoot("/nope")
    }
  }
}
