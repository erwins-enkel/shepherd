import Foundation
import Testing

@testable import ShepherdKit

@Suite("ShepherdClient reads")
struct ShepherdClientReadTests {
  /// Builds a client pointed at `server`, with `token` already stored.
  private func makeClient(
    _ server: FakeShepherdServer,
    credentials: InMemoryCredentialStore = InMemoryCredentialStore(),
    token: String? = "shp_test"
  ) throws -> (ShepherdClient, InMemoryCredentialStore) {
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    if let token { try credentials.save(StoredCredential(token: token, tokenId: "tok"), for: "k") }
    let client = try ShepherdClient(
      profile: profile, credentials: credentials, urlSession: server.urlSession())
    return (client, credentials)
  }

  @Test("health decodes and sends no Authorization requirement")
  func health() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/health", status: 200, json: try Fixtures.json(Fixtures.health()))
    let (client, _) = try makeClient(server)

    let health = try await client.health()
    #expect(health.ok == true)
    #expect(health.version == "1.47.0")
  }

  @Test("the stored token reaches the wire")
  func sendsBearer() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/sessions", status: 200, json: try Fixtures.json([Fixtures.session(id: "a")]))
    let (client, _) = try makeClient(server)

    _ = try await client.sessions()
    #expect(server.requests().last?.headers["Authorization"] == "Bearer shp_test")
  }

  @Test("sessions, done sessions and one session decode")
  func sessionReads() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/sessions", status: 200,
      json: try Fixtures.json([Fixtures.session(id: "a"), Fixtures.session(id: "b")]))
    server.stub(
      "GET", "/api/sessions/done", status: 200,
      json: try Fixtures.json([Fixtures.session(id: "z")]))
    server.stub(
      "GET", "/api/sessions/a", status: 200,
      json: try Fixtures.json(Fixtures.session(id: "a", name: "alpha")))
    let (client, _) = try makeClient(server)

    #expect(try await client.sessions().map(\.id) == ["a", "b"])
    #expect(try await client.doneSessions().map(\.id) == ["z"])
    #expect(try await client.session(id: "a").name == "alpha")
  }

  @Test("settings and repos decode")
  func settingsAndRepos() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/settings", status: 200,
      json: try Fixtures.json(Fixtures.settings(firstRunPending: true)))
    server.stub("GET", "/api/repos", status: 200, json: try Fixtures.json(Fixtures.repoList()))
    let (client, _) = try makeClient(server)

    #expect(try await client.settings().firstRunPending == true)
    #expect(try await client.repos().repos.first?.name == "demo")
  }

  @Test("a 401 becomes unauthenticated, clears the token and fires needsLogin")
  func unauthorized() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/sessions", status: 401,
      json: try Fixtures.errorJSON("unauthorized"))
    let (client, credentials) = try makeClient(server)

    let signal = Task {
      for await _ in client.needsLogin { return true }
      return false
    }

    await #expect(throws: ShepherdError.unauthenticated) { _ = try await client.sessions() }
    #expect(try credentials.load(for: "k") == nil)
    #expect(await signal.value == true)
  }

  @Test("a 404 on one session becomes notFound")
  func notFound() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/sessions/gone", status: 404, json: try Fixtures.errorJSON("no such session"))
    let (client, _) = try makeClient(server)

    await #expect(throws: ShepherdError.notFound) { _ = try await client.session(id: "gone") }
  }

  @Test("a body that does not match the contract becomes contractMismatch")
  func contractMismatch() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/settings", status: 200, json: Data(#"{"repoRoot":42}"#.utf8))
    let (client, _) = try makeClient(server)

    do {
      _ = try await client.settings()
      Issue.record("expected a contract mismatch")
    } catch let error as ShepherdError {
      guard case .contractMismatch(let route, _) = error else {
        Issue.record("expected contractMismatch, got \(error)")
        return
      }
      #expect(route == "getSettings")
    }
  }

  @Test("an undocumented status becomes contractMismatch")
  func undocumentedStatus() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/repos", status: 418, json: try Fixtures.errorJSON("teapot"))
    let (client, _) = try makeClient(server)

    await #expect(
      throws: ShepherdError.contractMismatch(route: "listRepos", underlying: "undocumented status 418")
    ) { _ = try await client.repos() }
  }

  @Test("an insecure remote profile is refused at construction")
  func insecureProfileRefused() throws {
    let profile = ServerProfile(
      name: "box", baseURL: URL(string: "http://box.example.com")!, mode: .remote)
    #expect(throws: ServerProfileError.insecureRemoteURL("box.example.com")) {
      _ = try ShepherdClient(profile: profile, credentials: InMemoryCredentialStore())
    }
  }
}
