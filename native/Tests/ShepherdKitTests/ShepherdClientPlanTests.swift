import Foundation
import Testing

@testable import ShepherdKit

@Suite("ShepherdClient plan gates")
struct ShepherdClientPlanTests {
  private func makeClient(_ server: FakeShepherdServer) throws -> ShepherdClient {
    let credentials = InMemoryCredentialStore()
    try credentials.save(StoredCredential(token: "shp_test", tokenId: "tok"), for: "k")
    let profile = ServerProfile(
      name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    return try ShepherdClient(
      profile: profile, credentials: credentials, urlSession: server.urlSession())
  }

  private func gateJSON(blocks: String) -> Data {
    Data(
      """
      {"s1":{"sessionId":"s1","planHash":"reviewed","decision":"approved",
      "summary":"Plan is sound","body":"Two decisions remain","findings":[],
      "round":1,"cap":3,"approved":true,"plan":"# Rate limiter",
      "livePlanHash":"live","answeredQuestionKeys":["b5 q1"],
      "updatedAt":1800000060000,"blocks":\(blocks)}}
      """.utf8)
  }

  @Test("gate map decodes six typed blocks and preserves the gate fields")
  func gateMap() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/plan-gates", status: 200,
      json: gateJSON(
        blocks: """
          [
            {"type":"rich-text","id":"b1","markdown":"Adds the token bucket."},
            {"type":"callout","id":"b2","tone":"risk","markdown":"Two bypasses."},
            {"type":"file-tree","id":"b3","entries":[{"path":"src/limiter.ts","change":"modified"}]},
            {"type":"checklist","id":"b4","items":[{"id":"i1","label":"wire route","checked":false}]},
            {"type":"question-form","id":"b5","questions":[{"id":"q1","prompt":"Which?","kind":"single","options":["IP","token"]}]},
            {"type":"table","id":"b6","columns":["route","limit"],"rows":[["/api","100/m"]]}
          ]
          """))
    let gates = try await makeClient(server).planGates()
    #expect(gates.count == 1)
    let gate = try #require(gates["s1"])
    #expect(gate.sessionId == "s1")
    #expect(gate.approved)
    #expect(gate.decision.known == .approved)
    #expect(gate.answeredQuestionKeys == ["b5 q1"])
    let blocks = try #require(gate.blocks)
    try #require(blocks.count == 6)
    #expect(blocks[0].value1?.markdown == "Adds the token bucket.")
    #expect(blocks[1].value2?.tone.known == .risk)
    #expect(blocks[2].value3?.entries.first?.change.known == .modified)
    #expect(blocks[3].value10?.items.first?.checked == false)
    #expect(blocks[4].value13?.questions.first?.kind.known == .single)
    #expect(blocks[5].value9?.rows == [["/api", "100/m"]])
  }

  @Test("unknown block preserves its markdown and the surrounding gate")
  func unknownBlock() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/plan-gates", status: 200,
      json: gateJSON(
        blocks: """
          [{"type":"future-chart","id":"future","markdown":"Fallback **chart**"}]
          """))
    let gate = try #require(try await makeClient(server).planGates()["s1"])
    #expect(gate.sessionId == "s1")
    #expect(gate.summary == "Plan is sound")
    #expect(gate.planHash == "reviewed")
    #expect(gate.plan == "# Rate limiter")
    #expect(gate.approved)
    #expect(gate.round == 1)
    #expect(gate.cap == 3)
    #expect(gate.updatedAt == 1_800_000_060_000)
    let fallback = try #require(gate.blocks?.first?.value14)
    #expect(fallback._type == "future-chart")
    #expect(fallback.markdown == "Fallback **chart**")
  }

  @Test("malformed known question forms cannot decode as unknown blocks")
  func malformedKnownBlock() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/plan-gates", status: 200,
      json: gateJSON(blocks: #"[{"type":"question-form","id":"bad","questions":"not an array"}]"#))
    await #expect(throws: ShepherdError.self) {
      _ = try await makeClient(server).planGates()
    }
  }

  @Test("inflight reviews retain their environment, including null model and effort")
  func inflight() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "GET", "/api/plan-gates/inflight", status: 200,
      json: Data(
        """
        [{"id":"s1","provider":"claude","model":"claude-opus-5","effort":"high"},
         {"id":"s2","model":null,"effort":null}]
        """.utf8))
    let entries = try await makeClient(server).planGatesInflight()
    try #require(entries.count == 2)
    #expect(entries[0].id == "s1")
    #expect(entries[0].provider == .claude)
    #expect(entries[0].model == "claude-opus-5")
    #expect(entries[0].effort == "high")
    #expect(entries[1].id == "s2")
    #expect(entries[1].model == nil)
    #expect(entries[1].effort == nil)
  }

  @Test(
    "release returns false on refusal, including unknown sessions", arguments: ["s1", "unknown"])
  func releaseRefused(id: String) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/\(id)/go", status: 409,
      json: try Fixtures.errorJSON("plan not approved or not in planning phase"))
    #expect(try await makeClient(server).releasePlanGate(sessionID: id) == false)
  }

  @Test("release returns true when execution starts")
  func releaseSuccess() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub("POST", "/api/sessions/s1/go", status: 200, json: Data(#"{"ok":true}"#.utf8))
    #expect(try await makeClient(server).releasePlanGate(sessionID: "s1"))
  }

  @Test("answers remain recorded even when delivery fails", arguments: [false, true])
  func answers(delivered: Bool) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/answer-plan-questions", status: 200,
      json: Data("{\"ok\":true,\"delivered\":\(delivered)}".utf8))
    let answers: [RawAnswer] = [
      .init(blockId: "b5", questionId: "q1", optionIndices: [1]),
      .init(blockId: "b5", questionId: "q2", optionIndices: []),
      .init(blockId: "b5", questionId: "q3", text: "30 seconds"),
    ]
    let result = try await makeClient(server).answerPlanQuestions(sessionID: "s1", answers: answers)
    #expect(result.ok)
    #expect(result.delivered == delivered)
    let body = try #require(server.requests().last?.body)
    let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    let sent = try #require(json["answers"] as? [[String: Any]])
    try #require(sent.count == 3)
    #expect(sent[0]["blockId"] as? String == "b5")
    #expect(sent[0]["questionId"] as? String == "q1")
    #expect(sent[0]["optionIndices"] as? [Int] == [1])
    #expect(sent[1]["optionIndices"] as? [Int] == [])
    #expect(sent[2]["text"] as? String == "30 seconds")
    #expect(sent[2]["optionIndices"] == nil)
  }

  @Test(
    "review decodes accepted outcomes",
    arguments: ["started", "started-at-cap", "plan-unavailable", "future"])
  func reviewAccepted(status: String) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/review-plan", status: 202,
      json: Data("{\"ok\":true,\"status\":\"\(status)\"}".utf8))
    let result = try await makeClient(server).reviewPlan(sessionID: "s1")
    #expect(result.ok)
    #expect(result.status.rawValue == status)
    #expect(result.status.known == PlanReviewTriggerKnown(rawValue: status))
  }

  @Test(
    "quota actions decode accepted outcomes", arguments: [false, true],
    ["resumed", "unreachable", "dismissed", "not-stalled", "future"])
  func quotaAccepted(dismiss: Bool, status: String) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    server.stub(
      "POST", "/api/sessions/s1/quota/\(dismiss ? "dismiss" : "resume")", status: 202,
      json: Data("{\"ok\":true,\"status\":\"\(status)\"}".utf8))
    let client = try makeClient(server)
    let result =
      try await dismiss
      ? client.dismissPlanQuota(sessionID: "s1") : client.resumePlanQuota(sessionID: "s1")
    #expect(result.ok)
    #expect(result.status.rawValue == status)
    #expect(result.status.known == PlanQuotaStatusKnown(rawValue: status))
  }

  enum Route: String, CaseIterable {
    case gates, inflight, release, answers, review, resume, dismiss

    var operationID: String {
      switch self {
      case .gates: "listPlanGates"
      case .inflight: "listPlanGatesInflight"
      case .release: "releasePlanGate"
      case .answers: "answerPlanQuestions"
      case .review: "reviewPlan"
      case .resume: "resumePlanQuota"
      case .dismiss: "dismissPlanQuota"
      }
    }

    func stub(_ server: FakeShepherdServer, status: Int, message: String) throws {
      let path: String
      switch self {
      case .gates: path = "/api/plan-gates"
      case .inflight: path = "/api/plan-gates/inflight"
      case .release: path = "/api/sessions/s1/go"
      case .answers: path = "/api/sessions/s1/answer-plan-questions"
      case .review: path = "/api/sessions/s1/review-plan"
      case .resume: path = "/api/sessions/s1/quota/resume"
      case .dismiss: path = "/api/sessions/s1/quota/dismiss"
      }
      server.stub(
        self == .gates || self == .inflight ? "GET" : "POST", path,
        status: status, json: try Fixtures.errorJSON(message))
    }

    func call(_ client: ShepherdClient) async throws {
      switch self {
      case .gates: _ = try await client.planGates()
      case .inflight: _ = try await client.planGatesInflight()
      case .release: _ = try await client.releasePlanGate(sessionID: "s1")
      case .answers: _ = try await client.answerPlanQuestions(sessionID: "s1", answers: [])
      case .review: _ = try await client.reviewPlan(sessionID: "s1")
      case .resume: _ = try await client.resumePlanQuota(sessionID: "s1")
      case .dismiss: _ = try await client.dismissPlanQuota(sessionID: "s1")
      }
    }
  }

  @Test(
    "every route maps unauthorized and undocumented responses", arguments: Route.allCases,
    [401, 418])
  func commonFailures(route: Route, status: Int) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try route.stub(server, status: status, message: "refused")
    let expected: ShepherdError =
      status == 401
      ? .unauthenticated
      : .contractMismatch(route: route.operationID, underlying: "undocumented status 418")
    let client = try makeClient(server)
    await #expect(throws: expected) { try await route.call(client) }
  }

  @Test(
    "documented errors preserve the server outcome",
    arguments: [
      (
        Route.answers, 400, "body must be {answers: RawAnswer[]}",
        ShepherdError.badRequest("body must be {answers: RawAnswer[]}")
      ),
      (.answers, 400, "no answers resolved", .badRequest("no answers resolved")),
      (
        .answers, 409, "not in planning phase",
        .conflict(code: nil, message: "not in planning phase")
      ),
      (.answers, 409, "no plan questions", .conflict(code: nil, message: "no plan questions")),
      (.answers, 404, "not found", .notFound),
      (.review, 404, "not found", .notFound),
      (.resume, 404, "not found", .notFound),
      (.resume, 404, "no forge for this repo", .notFound),
      (.dismiss, 404, "not found", .notFound),
      (
        .resume, 502, "forge lookup failed",
        .upstreamFailure(code: nil, message: "forge lookup failed")
      ),
    ])
  func documentedFailures(_ c: (Route, Int, String, ShepherdError)) async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    try c.0.stub(server, status: c.1, message: c.2)
    let client = try makeClient(server)
    await #expect(throws: c.3) { try await c.0.call(client) }
  }

  @Test("future plan phases and wireframe surfaces decode without losing their wire value")
  func futureReadEnums() throws {
    let decoder = JSONDecoder()
    let event = try decoder.decode(
      SessionPlanGateEvent.self,
      from: Data(#"{"id":"s1","planPhase":"verifying"}"#.utf8))
    let wireframe = try decoder.decode(
      VisualBlockWireframe.self,
      from: Data(#"{"type":"wireframe","id":"w1","surface":"spatial","html":"<p>Plan</p>"}"#.utf8))
    let encoder = JSONEncoder()
    let eventJSON = try JSONSerialization.jsonObject(with: encoder.encode(event)) as? [String: Any]
    let blockJSON = try JSONSerialization.jsonObject(with: encoder.encode(wireframe)) as? [String: Any]
    #expect(eventJSON?["planPhase"] as? String == "verifying")
    #expect(blockJSON?["surface"] as? String == "spatial")
  }

  @Test("all nine plan open enums retain unknown wire values")
  func openEnums() throws {
    func check<T: OpenEnum & Decodable>(_ type: T.Type, known: String) throws {
      let decoder = JSONDecoder()
      let value = try decoder.decode(type, from: Data("\"\(known)\"".utf8))
      #expect(value.known?.rawValue == known)
      #expect(value.rawValue == known)
      let future = try decoder.decode(type, from: Data(#""future""#.utf8))
      #expect(future.known == nil)
      #expect(future.rawValue == "future")
    }
    try check(Components.Schemas.WireframeSurface.self, known: "browser")
    try check(Components.Schemas.PlanGatePhase.self, known: "planning")
    try check(PlanDecision.self, known: "approved")
    try check(PlanSummaryCode.self, known: "no-verdict")
    try check(CalloutTone.self, known: "risk")
    try check(FileTreeChange.self, known: "modified")
    try check(QuestionKind.self, known: "single")
    try check(PlanReviewTrigger.self, known: "started-at-cap")
    try check(PlanQuotaStatus.self, known: "not-stalled")
  }
}
