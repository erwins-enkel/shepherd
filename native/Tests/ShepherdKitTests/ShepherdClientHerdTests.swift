import Foundation
import Testing

@testable import ShepherdKit

@Suite("ShepherdClient herd snapshots")
struct ShepherdClientHerdTests {
  private func makeClient(_ server: FakeShepherdServer) throws -> ShepherdClient {
    let credentials = InMemoryCredentialStore()
    try credentials.save(StoredCredential(token: "shp_test", tokenId: "tok"), for: "k")
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    return try ShepherdClient(
      profile: profile, credentials: credentials, urlSession: server.urlSession())
  }

  @Test func gitStatesDecodesTheFiveFieldsTheClassifierNeeds() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/git", status: 200,
      json: Data("""
        {"sess_a":{"kind":"github","state":"open","checks":"success","noCi":false,
         "handoff":"reviewer","handoffWho":"r1","headSha":"abc","deployConfigured":false,
         "reviewBlock":{"reviewer":"r1","state":"changes_requested","latestAt":1}}}
        """.utf8))
    let map = try await makeClient(server).gitStates()
    let row = try #require(map["sess_a"])
    #expect(row.noCi == false)
    #expect(row.handoff?.known == .reviewer)
    #expect(row.handoffWho == "r1")
    #expect(row.headSha == "abc")
    #expect(row.reviewBlock?.reviewer == "r1")
    #expect(server.requests().count == 1)
  }

  @Test func anUnknownHandoffStillDecodes() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/git", status: 200,
      json: Data("""
        {"sess_a":{"state":"open","checks":"none","deployConfigured":false,"handoff":"triager"}}
        """.utf8))
    let row = try #require(try await makeClient(server).gitStates()["sess_a"])
    #expect(row.handoff?.known == nil)
    #expect(row.handoff?.rawValue == "triager")
  }

  @Test func activityStatesDecodesHeartbeats() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/activity", status: 200,
      json: Data("""
        {"sess_a":{"lastActivityTs":123,"summary":"editing","recentTs":[120,123],
         "recentErrTs":[121]},
         "sess_b":{"lastActivityTs":0,"summary":null,"recentTs":[],"recentErrTs":[]}}
        """.utf8))
    let map = try await makeClient(server).activityStates()
    let row = try #require(map["sess_a"])
    #expect(row.lastActivityTs == 123)
    #expect(row.summary == "editing")
    #expect(row.recentTs == [120, 123])
    #expect(row.recentErrTs == [121])
    #expect(try #require(map["sess_b"]).summary == nil)
    #expect(map["missing"] == nil)
    #expect(server.requests().count == 1)
  }

  @Test func claudeAliveStatesPreservesFalseAndAbsentSessions() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/claude-alive", status: 200,
      json: Data(#"{"sess_a":true,"sess_b":false}"#.utf8))
    let map = try await makeClient(server).claudeAliveStates()
    #expect(map == ["sess_a": true, "sess_b": false])
    #expect(map["missing"] == nil)
    #expect(server.requests().count == 1)
  }

  @Test(arguments: ["changes_requested", "future_decision"])
  func reviewsDecodesVerdictsIncludingUnknownDecisions(_ decision: String) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/reviews", status: 200,
      json: Data("""
        {"sess_a":{"sessionId":"sess_a","headSha":"abc","decision":"\(decision)",
         "summary":"needs work","body":"Fix the edge case.","findings":["edge case"],
         "addressRound":1,"addressCap":3,"finalRoundPending":true,
         "finalRoundTimeoutMs":1000,"updatedAt":123}}
        """.utf8))
    let row = try #require(try await makeClient(server).reviews()["sess_a"])
    #expect(row.sessionId == "sess_a")
    #expect(row.headSha == "abc")
    #expect(row.decision.rawValue == decision)
    #expect(row.decision.known == (decision == "changes_requested" ? .changesRequested : nil))
    #expect(row.findings == ["edge case"])
    #expect(row.addressRound == 1)
    #expect(row.addressCap == 3)
    #expect(row.finalRoundPending)
    #expect(row.dismissed == nil)
    #expect(server.requests().count == 1)
  }

  @Test func reviewsInflightDecodesReviewerEnvironments() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/reviews/inflight", status: 200,
      json: Data("""
        [{"id":"sess_a","provider":"codex","model":"gpt-6-astra","effort":"high"},
         {"id":"sess_b","model":null,"effort":null}]
        """.utf8))
    let rows = try await makeClient(server).reviewsInflight()
    #expect(rows.count == 2)
    let row = try #require(rows.first)
    #expect(row.id == "sess_a")
    #expect(row.provider?.known == .codex)
    #expect(row.model == "gpt-6-astra")
    #expect(row.effort == "high")
    let defaultEnv = try #require(rows.last)
    #expect(defaultEnv.id == "sess_b")
    #expect(defaultEnv.provider == nil)
    #expect(defaultEnv.model == nil)
    #expect(defaultEnv.effort == nil)
    #expect(server.requests().count == 1)
  }

  @Test func unknownReviewerProvidersSurviveBothReadPayloads() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/reviews/inflight", status: 200,
      json: Data(#"[{"id":"sess_a","provider":"future_cli","model":null,"effort":null}]"#.utf8))
    let rows = try await makeClient(server).reviewsInflight()
    #expect(rows.count == 1)
    #expect(rows.first?.provider?.known == nil)
    #expect(rows.first?.provider?.rawValue == "future_cli")

    let event = try JSONDecoder().decode(
      Components.Schemas.SessionReviewingEvent.self,
      from: Data(#"{"id":"sess_a","reviewing":true,"env":{"provider":"future_cli","model":null,"effort":null}}"#.utf8))
    #expect(event.env?.provider?.known == nil)
    #expect(event.env?.provider?.rawValue == "future_cli")
  }

  @Test func everyReadMapsFourOhOneToUnauthenticated() async throws {
    for path in ["/api/git", "/api/activity", "/api/claude-alive", "/api/reviews", "/api/reviews/inflight"] {
      let server = FakeShepherdServer()
      defer { server.tearDown() }
      server.stub("GET", path, status: 401, json: Data(#"{"error":"unauthorized"}"#.utf8))
      let client = try makeClient(server)
      await #expect(throws: ShepherdError.unauthenticated) {
        try await read(path, client: client)
      }
    }
  }

  @Test(arguments: [
    ("/api/git", "gitStates"), ("/api/activity", "activityStates"),
    ("/api/claude-alive", "claudeAliveStates"), ("/api/reviews", "listReviews"),
    ("/api/reviews/inflight", "listReviewsInflight"),
  ])
  func everyReadMapsUndocumentedStatuses(_ route: (String, String)) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("GET", route.0, status: 418, json: Data(#"{"error":"unexpected"}"#.utf8))
    let client = try makeClient(server)
    await #expect(throws: ShepherdError.contractMismatch(
      route: route.1, underlying: "undocumented status 418")) {
      try await read(route.0, client: client)
    }
  }

  private func read(_ path: String, client: ShepherdClient) async throws {
    switch path {
    case "/api/git": _ = try await client.gitStates()
    case "/api/activity": _ = try await client.activityStates()
    case "/api/claude-alive": _ = try await client.claudeAliveStates()
    case "/api/reviews": _ = try await client.reviews()
    default: _ = try await client.reviewsInflight()
    }
  }

  @Test func reviewPrMapsBothFourOhFourBodiesToNotFound() async throws {
    for body in [#"{"error":"not found"}"#, #"{"error":"no forge for this repo"}"#] {
      let server = FakeShepherdServer()
      defer { server.tearDown() }
      server.stub("POST", "/api/sessions/sess_a/review-pr", status: 404, json: Data(body.utf8))
      await #expect(throws: ShepherdError.notFound) {
        _ = try await makeClient(server).reviewPr(sessionID: "sess_a")
      }
    }
  }

  @Test func reviewPrAcceptsTheTwoOhTwo() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/sess_a/review-pr", status: 202,
      json: Data(#"{"ok":true,"status":"started"}"#.utf8))
    let result = try await makeClient(server).reviewPr(sessionID: "sess_a")
    #expect(result.ok)
    #expect(result.status.known == .started)
    #expect(server.requests().count == 1)
  }

  @Test(arguments: ["skipped", "error", "queued"])
  func reviewPrPreservesOtherAcceptedStatuses(_ status: String) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/sess_a/review-pr", status: 202,
      json: Data("{\"ok\":true,\"status\":\"\(status)\"}".utf8))
    let result = try await makeClient(server).reviewPr(sessionID: "sess_a")
    #expect(result.status.rawValue == status)
    #expect(result.status.known == PrReviewTriggerKnown(rawValue: status))
  }

  @Test(arguments: [
    (401, ShepherdError.unauthenticated),
    (502, ShepherdError.upstreamFailure("forge failed")),
    (200, ShepherdError.contractMismatch(route: "reviewPr", underlying: "undocumented status 200")),
    (500, ShepherdError.contractMismatch(route: "reviewPr", underlying: "undocumented status 500")),
  ])
  func reviewPrMapsOtherFailures(_ response: (Int, ShepherdError)) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/sess_a/review-pr", status: response.0,
      json: Data(#"{"error":"forge failed"}"#.utf8))
    await #expect(throws: response.1) {
      _ = try await makeClient(server).reviewPr(sessionID: "sess_a")
    }
    #expect(server.requests().count == 1)
  }
}
