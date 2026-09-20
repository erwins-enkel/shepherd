import Foundation
import OpenAPIRuntime
import Testing

@testable import ShepherdKit

// A separate-file extension is also a compile-time guard for the stream seam.
extension ShepherdClient {
  func probeLongRunningHealth() async throws -> Health {
    switch try await longRunning.getHealth(.init()) {
    case .ok(let ok): return try ok.body.json
    case .undocumented(let status, _):
      throw ShepherdError.fromUndocumented(statusCode: status, route: "getHealth")
    }
  }
}

@Suite("ShepherdClient long-running operations", .timeLimit(.minutes(1)))
struct ShepherdClientLongRunningTests {
  private func profile(_ server: FakeShepherdServer) -> ServerProfile {
    ServerProfile(name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
  }

  @Test("ordinary operations retain 60 seconds while the opt-in path gets 300")
  func productionTimeouts() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/health", status: 200, json: try Fixtures.json(Fixtures.health()))
    let session = server.urlSession()
    defer { session.invalidateAndCancel() }
    let client = try ShepherdClient(
      profile: profile(server), credentials: InMemoryCredentialStore(), urlSession: session)

    _ = try await client.health()
    _ = try await client.probeLongRunningHealth()
    _ = try await client.health()

    #expect(session.configuration.timeoutIntervalForRequest == 60)
    #expect(URLSession.shared.configuration.timeoutIntervalForRequest == 60)
    #expect(client.longRunningURLSession.configuration.timeoutIntervalForRequest == 300)
    #expect(client.longRunningURLSession.configuration.timeoutIntervalForResource >= 300)
    #expect(server.requests().count == 3)
  }

  @Test(
    "a delayed response outlasts the default timeout but succeeds on the long path",
    arguments: [0.5, 604_800.0])
  func delayedResponse(resourceTimeout: TimeInterval) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.on("GET", "/api/health") { _ in
      FakeResponse(body: try Fixtures.json(Fixtures.health()), delay: 1)
    }
    // Scale the production 60/300-second windows down for a short regression.
    // Exercise both request-only expiry and a resource deadline that must be raised.
    let session = server.urlSession(requestTimeout: 0.5, resourceTimeout: resourceTimeout)
    defer { session.invalidateAndCancel() }
    let client = try ShepherdClient(
      profile: profile(server), credentials: InMemoryCredentialStore(), urlSession: session,
      longRunningRequestTimeout: 3)

    do {
      _ = try await client.generated.getHealth(.init())
      Issue.record("the ordinary client must time out before the delayed response")
    } catch let error as ClientError {
      #expect((error.underlyingError as? URLError)?.code == .timedOut)
    }
    #expect(try await client.probeLongRunningHealth().ok)
    #expect(server.requests().count == 4)  // Three default GET attempts, one long attempt.
    #expect(session.configuration.timeoutIntervalForRequest == 0.5)
    #expect(session.configuration.timeoutIntervalForResource == resourceTimeout)
    #expect(client.longRunningURLSession.configuration.timeoutIntervalForRequest == 3)
    #expect(
      client.longRunningURLSession.configuration.timeoutIntervalForResource
        == max(3, resourceTimeout))
  }

  @Test("both paths read current credentials and share the login signal")
  func sharesAuthentication() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/health", status: 200, json: try Fixtures.json(Fixtures.health()))
    let credentials = InMemoryCredentialStore()
    try credentials.save(StoredCredential(token: "first", tokenId: "1"), for: "k")
    let client = try ShepherdClient(
      profile: profile(server), credentials: credentials, urlSession: server.urlSession())
    _ = try await client.health()
    try credentials.save(StoredCredential(token: "second", tokenId: "2"), for: "k")
    _ = try await client.probeLongRunningHealth()
    #expect(
      server.requests().map { $0.headers["Authorization"] } == ["Bearer first", "Bearer second"])

    server.stub("GET", "/api/health", status: 401, json: try Fixtures.errorJSON("unauthorized"))
    let signal = Task {
      for await _ in client.needsLogin { return true }
      return false
    }
    defer { signal.cancel() }
    await #expect(throws: ShepherdError.unauthenticated) {
      _ = try await client.probeLongRunningHealth()
    }
    #expect(try credentials.load(for: "k") == nil)
    #expect(client.currentToken() == nil)
    #expect(await signal.value)
    #expect(server.requests().count == 3)
  }
}
