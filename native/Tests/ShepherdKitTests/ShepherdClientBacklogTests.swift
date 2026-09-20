import Foundation
import Testing

@testable import ShepherdKit

@Suite("ShepherdClient sidebar reads", .timeLimit(.minutes(1)))
struct ShepherdClientBacklogTests {
  private func makeClient(_ server: FakeShepherdServer) throws -> ShepherdClient {
    let credentials = InMemoryCredentialStore()
    try credentials.save(StoredCredential(token: "shp_test", tokenId: "tok"), for: "k")
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    return try ShepherdClient(
      profile: profile, credentials: credentials, urlSession: server.urlSession())
  }

  /// Encode-then-decode: every fixture is produced from the generated type, so it cannot disagree
  /// with the contract.
  private func json<T: Encodable>(_ value: T) throws -> Data { try JSONEncoder().encode(value) }

  @Test("working-blocked, holds and blocks decode into their maps")
  func maps() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/working-blocked", status: 200,
      json: try json(
        Components.Schemas.WorkingBlockedMap(additionalProperties: ["a": true, "b": false])))
    let hold = Components.Schemas.HoldReason(
      code: HoldCode(known: .quotaRework), params: .init(round: 2, cap: 5))
    server.stub(
      "GET", "/api/holds", status: 200,
      json: try json(Components.Schemas.HoldMap(additionalProperties: ["s1": hold])))
    let block = Components.Schemas.BlockReason(
      shape: .init(value1: .stall), options: [], tail: ["waiting"])
    server.stub(
      "GET", "/api/blocks", status: 200,
      json: try json(Components.Schemas.BlockMap(additionalProperties: ["s1": block])))
    let client = try makeClient(server)

    let flags = try await client.workingBlocked()
    #expect(flags["a"] == true)
    #expect(flags["b"] == false)
    let holds = try await client.holds()
    #expect(holds["s1"]?.code.known == .quotaRework)
    #expect(holds["s1"]?.params?.round == 2)
    #expect(try await client.blocks()["s1"]?.tail == ["waiting"])
  }

  @Test("a hold code this build has never heard of survives as its raw value")
  func unknownHoldCode() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/holds", status: 200, json: Data(#"{"s1":{"code":"quantum-hold"}}"#.utf8))

    let holds = try await makeClient(server).holds()
    #expect(holds["s1"]?.code.known == nil)
    #expect(holds["s1"]?.code.rawValue == "quantum-hold")
  }

  @Test("usage returns the wrapper, not bare limits")
  func usage() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let limits = Components.Schemas.UsageLimits(
      session5h: .init(pct: 42, resetAt: 1_800_000_000_000),
      week: nil, perModelWeek: [], credits: nil,
      stale: false, calibratedAt: nil, subscriptionOnly: false)
    server.stub(
      "GET", "/api/usage/limits", status: 200,
      json: try json(Components.Schemas.UsageLimitsResponse(limits: limits, projections: [])))

    let usage = try await makeClient(server).usage()
    #expect(usage.limits.session5h?.pct == 42)
    #expect(usage.projections.isEmpty)
  }

  @Test("a 401 maps to unauthenticated on every sidebar read")
  func unauthorized() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let body = Data(#"{"error":"unauthorized"}"#.utf8)
    for path in ["/api/working-blocked", "/api/holds", "/api/blocks", "/api/usage/limits"] {
      server.stub("GET", path, status: 401, json: body)
    }
    let client = try makeClient(server)

    await #expect(throws: ShepherdError.unauthenticated) { _ = try await client.workingBlocked() }
    await #expect(throws: ShepherdError.unauthenticated) { _ = try await client.holds() }
    await #expect(throws: ShepherdError.unauthenticated) { _ = try await client.blocks() }
    await #expect(throws: ShepherdError.unauthenticated) { _ = try await client.usage() }
  }
}
