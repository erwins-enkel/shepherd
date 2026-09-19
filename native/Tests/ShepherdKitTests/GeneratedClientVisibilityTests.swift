import Foundation
import Testing

@testable import ShepherdKit

/// Stands in for the per-stream extension files S1–S4 add inside the kit
/// (`ShepherdClient+Terminal.swift`, `+Detail.swift`, `+Backlog.swift`,
/// `+Actions.swift`). They reach the generated client exactly like this.
///
/// This extension is the regression guard: narrow `generated` back to `private`
/// and this file stops COMPILING. A visibility regression must be a build
/// failure here, not a surprise in four stream worktrees at once.
extension ShepherdClient {
  /// The one move every stream wrapper makes: call a generated operation and
  /// map its `Output` enum. `getHealth` is used because it is the contract's
  /// only `security: []` route, so this needs no credential.
  func probeGeneratedClientIsReachable() async throws -> Bool {
    switch try await generated.getHealth(.init()) {
    case .ok: return true
    case .undocumented: return false
    }
  }
}

@Suite("generated client visibility")
struct GeneratedClientVisibilityTests {
  @Test("a kit extension in another file can reach ShepherdClient.generated")
  func extensionReachesTheGeneratedClient() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", "/api/health", status: 200, json: try Fixtures.json(Fixtures.health()))
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    let client = try ShepherdClient(
      profile: profile, credentials: InMemoryCredentialStore(), urlSession: server.urlSession())

    let reachable = try await client.probeGeneratedClientIsReachable()
    #expect(reachable)
  }
}
