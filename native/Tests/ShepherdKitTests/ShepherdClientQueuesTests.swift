import Foundation
import Testing
@testable import ShepherdKit

struct ShepherdClientQueuesTests {
    @Test func queueReadEnumsPreserveKnownAndUnknownValues() throws {
        try checkOpenEnum(Components.Schemas.HeldReason.self, known: .usage)
        try checkOpenEnum(Components.Schemas.UpNextKind.self, known: .epic)
        try checkOpenEnum(Components.Schemas.UsageSource.self, known: .snapshot)
        try checkOpenEnum(Components.Schemas.UpNextSection.KindPayload.self, known: .priority)
        try checkOpenEnum(Components.Schemas.SessionHaltEvent.HaltReasonPayload.self, known: .completed)
    }

    private func checkOpenEnum<T: OpenEnum & Codable>(_ type: T.Type, known: T.Known) throws {
        let decoder = JSONDecoder()
        let encoder = JSONEncoder()
        let decoded = try decoder.decode(T.self, from: encoder.encode(known.rawValue))
        #expect(decoded.known == known)
        #expect(decoded.rawValue == known.rawValue)
        #expect(try decoder.decode(T.self, from: encoder.encode(T(known: known))).known == known)
        let unknown = try decoder.decode(T.self, from: encoder.encode("future-queue-value"))
        #expect(unknown.known == nil)
        #expect(unknown.rawValue == "future-queue-value")
        let roundTrip = try decoder.decode(T.self, from: encoder.encode(T(unknown: "future-queue-value")))
        #expect(roundTrip.known == nil)
        #expect(roundTrip.rawValue == "future-queue-value")
    }

    private func client(_ server: FakeShepherdServer) throws -> ShepherdClient {
        try ShepherdClient(profile: .init(name: "fake", baseURL: server.baseURL, mode: .local,
                                         credentialKey: "queues-test"),
                           credentials: InMemoryCredentialStore(), urlSession: server.urlSession())
    }

    @Test func sessionUsageIsAReadAndPreservesMeasuredZero() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("GET", "/api/sessions/s1/usage", status: 200,
                    json: Data(#"{"available":true,"source":"snapshot","total":0,"input":null,"output":null,"cacheRead":null,"cacheWrite":null,"messageCount":null,"byModel":null}"#.utf8))
        let usage = try await client(server).sessionUsage(id: "s1")
        #expect(usage.available && usage.total == 0)
        #expect(server.requests().count == 1)
    }

    @Test(arguments: [401, 404, 418])
    func sessionUsageMapsFailures(status: Int) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("GET", "/api/sessions/s1/usage", status: status, json: Data(#"{"error":"missing"}"#.utf8))
        let expected: ShepherdError = switch status {
        case 401: .unauthenticated
        case 404: .notFound
        default: .contractMismatch(route: "sessionUsage", underlying: "undocumented status 418")
        }
        await #expect(throws: expected) { _ = try await client(server).sessionUsage(id: "s1") }
    }
}

extension ShepherdClientQueuesTests {
    private func requestJSON(_ server: FakeShepherdServer) throws -> [String: Any] {
        let data = try #require(server.requests().last?.body)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private var startItem: UpNextStartItem {
        .init(repoPath: "/repo", issueRef: .init(number: 42, url: "https://example.test/42",
                                               title: "Queue", body: "Implement"))
    }

    @Test(arguments: [false, true])
    func spawnHeldReturnsCreatedSessionAndEncodesOverride(override: Bool) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/held/h1/spawn", status: 201,
                    json: try Fixtures.json(Fixtures.session(id: "created")))
        let session = try await client(server).spawnHeld(id: "h1", agentProvider: override ? .codex : nil)
        #expect(session.id == "created")
        if override {
            #expect(try requestJSON(server) as NSDictionary == ["agentProvider": "codex"] as NSDictionary)
        } else {
            #expect(try requestJSON(server).isEmpty)
        }
        #expect(server.requests().count == 1)
    }

    @Test(arguments: [
        (400, "invalid", nil, ShepherdError.badRequest("invalid")),
        (401, "login", nil, .unauthenticated),
        (403, "sandbox refused", nil, .forbidden),
        (404, "missing", nil, .notFound),
        (409, "first_run_pending", nil, .firstRunPending),
        (409, "occupied", "worktree_occupied", .conflict(code: "worktree_occupied", message: "occupied")),
        (409, "restart", "herdr_restart_required", .conflict(code: "herdr_restart_required", message: "restart")),
        (422, "base gone", nil, .unprocessable("base gone")),
        (502, "spawn failed", "spawn_failed", .upstreamFailure(code: "spawn_failed", message: "spawn failed")),
        (418, "unexpected", nil, .contractMismatch(route: "spawnHeld", underlying: "undocumented status 418")),
    ] as [(Int, String, String?, ShepherdError)])
    func spawnHeldMapsCreateFailureLadder(_ c: (Int, String, String?, ShepherdError)) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/held/h1/spawn", status: c.0,
                    json: try Fixtures.errorJSON(c.1, code: c.2))
        await #expect(throws: c.3) { _ = try await client(server).spawnHeld(id: "h1", agentProvider: nil) }
        #expect(server.requests().count == 1)
    }

    @Test(arguments: [201, 200, 502])
    func startUpNextPreservesOutcomeAndAllArrays(status: Int) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        let body = Components.Schemas.UpNextStartResult(
            created: status == 201 ? [Fixtures.session(id: "created")] : [],
            held: status == 502 ? [] : [.init(id: "held", repoPath: "/repo", number: 43, reused: true)],
            errors: [.init(number: 44, error: "no forge for repo")])
        server.stub("POST", "/api/up-next/start", status: status, json: try Fixtures.json(body))
        let result = try await client(server).startUpNext(
            items: [startItem], choice: .init(agentProvider: .codex, model: "gpt-5", effort: "high"))
        let expected: UpNextStartResult.Outcome = status == 201 ? .created : status == 200 ? .held : .allErrors
        #expect(result.outcome == expected)
        #expect(result.body == body)
        #expect(result.created == body.created && result.held == body.held && result.errors == body.errors)
        let sent = try requestJSON(server)
        #expect(Set(sent.keys) == ["items", "agentProvider", "model", "effort"])
        #expect(sent["agentProvider"] as? String == "codex")
        #expect(sent["model"] as? String == "gpt-5")
        #expect(sent["effort"] as? String == "high")
        let items = try #require(sent["items"] as? [[String: Any]])
        #expect(items.count == 1 && items[0]["repoPath"] as? String == "/repo")
        #expect((items[0]["issueRef"] as? [String: Any])?["number"] as? Int == 42)
        #expect(server.requests().count == 1)
    }

    @Test func startUpNextOmitsAbsentChoice() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/up-next/start", status: 502,
                    json: Data(#"{"created":[],"held":[],"errors":[{"number":42,"error":"failed"}]}"#.utf8))
        _ = try await client(server).startUpNext(items: [startItem], choice: nil)
        #expect(Set(try requestJSON(server).keys) == ["items"])
    }

    @Test func discardHeldIsIdempotentAndLeavesRereadToCaller() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("DELETE", "/api/held/missing", status: 200, json: Data(#"{"ok":true}"#.utf8))
        let api = try client(server)
        try await api.discardHeld(id: "missing")
        try await api.discardHeld(id: "missing")
        #expect(server.requests().map(\.method) == ["DELETE", "DELETE"])
    }

    @Test func restoreReturnsSession() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/sessions/s1/restore", status: 200,
                    json: try Fixtures.json(Fixtures.session(id: "s1")))
        #expect(try await client(server).restore(sessionID: "s1").id == "s1")
        #expect(server.requests().last?.body?.isEmpty != false)
    }

    @Test(arguments: ["in_progress", "not_archived", "cannot_restore", "branch_gone", "branch_in_use", "spawn_refused", "future_reason"])
    func restorePreservesTypedConflictReason(code: String) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/sessions/s1/restore", status: 409,
                    json: try Fixtures.errorJSON("operator sentence", code: code))
        do {
            _ = try await client(server).restore(sessionID: "s1")
            Issue.record("Expected a restore conflict")
        } catch let conflict as RestoreConflict {
            #expect(conflict.code.rawValue == code)
            #expect(conflict.error == "operator sentence")
            #expect(conflict.code.known?.rawValue == (code == "future_reason" ? nil : code))
        }
        #expect(server.requests().count == 1)
    }

    @Test func heldListAndReplacementKeepStoredInput() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        let entry = Data(#"{"id":"h1","repoPath":"/repo","input":{"repoPath":"/repo","baseBranch":"main","prompt":"Held"},"createdAt":1800000000000,"reason":"capacity"}"#.utf8)
        server.stub("GET", "/api/held", status: 200, json: Data("[".utf8) + entry + Data("]".utf8))
        server.stub("PATCH", "/api/held/h1", status: 200, json: entry)
        let api = try client(server)
        let held = try await api.heldTasks()
        #expect(held.count == 1 && held[0].reason?.known == .capacity)
        let updated = try await api.updateHeld(id: "h1", input: .init(repoPath: "/repo", baseBranch: "main", prompt: "Held"))
        #expect(updated.id == "h1" && updated.input.prompt == "Held")
        #expect(try requestJSON(server)["prompt"] as? String == "Held")
        #expect(try requestJSON(server)["repoPath"] as? String == "/repo")
        #expect(try requestJSON(server)["baseBranch"] as? String == "main")
    }

    @Test func herdControlsReturnServerCountsAndEncodeSelections() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/up-next/refresh", status: 202, json: Data(#"{"ok":true}"#.utf8))
        server.stub("POST", "/api/halt", status: 200, json: Data(#"{"halted":2}"#.utf8))
        server.stub("POST", "/api/retry", status: 200, json: Data(#"{"resumed":1,"steered":0,"total":2}"#.utf8))
        server.stub("GET", "/api/stranded", status: 200, json: Data(#"["s1","s2"]"#.utf8))
        server.stub("POST", "/api/revive-stranded", status: 200, json: Data(#"{"revived":1,"failed":1}"#.utf8))
        server.stub("POST", "/api/broadcast", status: 200, json: Data(#"{"delivered":1,"queued":2,"offline":3,"skipped":4,"total":10}"#.utf8))
        let api = try client(server)
        try await api.refreshUpNext()
        #expect(try await api.halt().halted == 2)
        let retry = try await api.retry(ids: ["s1", "missing"], text: "Continue")
        #expect(retry.resumed == 1 && retry.steered == 0 && retry.total == 2)
        #expect(try requestJSON(server)["ids"] as? [String] == ["s1", "missing"])
        #expect(try requestJSON(server)["text"] as? String == "Continue")
        #expect(try await api.strandedSessions() == ["s1", "s2"])
        let revived = try await api.reviveStranded()
        #expect(revived.revived == 1 && revived.failed == 1)
        let broadcast = try await api.broadcast(ids: ["s1", "s2"], text: "Review")
        #expect(broadcast.delivered == 1 && broadcast.queued == 2 && broadcast.offline == 3)
        #expect(broadcast.skipped == 4 && broadcast.total == 10)
        #expect(try requestJSON(server)["ids"] as? [String] == ["s1", "s2"])
        #expect(try requestJSON(server)["text"] as? String == "Review")
        #expect(server.requests().count == 6)
    }
}

extension ShepherdClientQueuesTests {
    private enum Route: CaseIterable, Sendable {
        case held, update, spawn, discard, refresh, start, halt, retry, stranded, revive, restore, usage, broadcast

        var operation: String {
            switch self {
            case .held: "listHeld"
            case .update: "updateHeld"
            case .spawn: "spawnHeld"
            case .discard: "discardHeld"
            case .refresh: "refreshUpNext"
            case .start: "startUpNext"
            case .halt: "haltHerd"
            case .retry: "retryHalted"
            case .stranded: "listStranded"
            case .revive: "reviveStranded"
            case .restore: "restoreSession"
            case .usage: "sessionUsage"
            case .broadcast: "broadcast"
            }
        }

        var method: String {
            switch self {
            case .held, .stranded, .usage: "GET"
            case .update: "PATCH"
            case .discard: "DELETE"
            default: "POST"
            }
        }

        var path: String {
            switch self {
            case .held: "/api/held"
            case .update, .discard: "/api/held/h1"
            case .spawn: "/api/held/h1/spawn"
            case .refresh: "/api/up-next/refresh"
            case .start: "/api/up-next/start"
            case .halt: "/api/halt"
            case .retry: "/api/retry"
            case .stranded: "/api/stranded"
            case .revive: "/api/revive-stranded"
            case .restore: "/api/sessions/s1/restore"
            case .usage: "/api/sessions/s1/usage"
            case .broadcast: "/api/broadcast"
            }
        }

        func call(_ client: ShepherdClient) async throws {
            switch self {
            case .held: _ = try await client.heldTasks()
            case .update: _ = try await client.updateHeld(id: "h1", input: .init(repoPath: "/repo", baseBranch: "main", prompt: "Task"))
            case .spawn: _ = try await client.spawnHeld(id: "h1", agentProvider: nil)
            case .discard: try await client.discardHeld(id: "h1")
            case .refresh: try await client.refreshUpNext()
            case .start: _ = try await client.startUpNext(items: [], choice: nil)
            case .halt: _ = try await client.halt()
            case .retry: _ = try await client.retry(ids: ["s1"], text: "Continue")
            case .stranded: _ = try await client.strandedSessions()
            case .revive: _ = try await client.reviveStranded()
            case .restore: _ = try await client.restore(sessionID: "s1")
            case .usage: _ = try await client.sessionUsage(id: "s1")
            case .broadcast: _ = try await client.broadcast(ids: ["s1"], text: "Review")
            }
        }
    }

    @Test(arguments: Route.allCases, [401, 418])
    private func everyRouteMapsAuthenticationAndUnexpectedStatus(route: Route, status: Int) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub(route.method, route.path, status: status, json: try Fixtures.errorJSON("failed"))
        let expected: ShepherdError = status == 401 ? .unauthenticated
            : .contractMismatch(route: route.operation, underlying: "undocumented status 418")
        await #expect(throws: expected) { try await route.call(client(server)) }
    }

    @Test(arguments: [
        (Route.update, 400, ShepherdError.badRequest("failed")),
        (.update, 404, .notFound),
        (.start, 400, .badRequest("failed")),
        (.start, 409, .conflict(code: nil, message: "failed")),
        (.refresh, 503, .upstreamFailure("failed")),
        (.halt, 405, .contractMismatch(route: "haltHerd", underlying: "POST /api/halt returned 405 Method Not Allowed")),
        (.halt, 500, .contractMismatch(route: "haltHerd", underlying: "undocumented status 500")),
        (.retry, 400, .badRequest("failed")),
        (.restore, 404, .notFound),
        (.broadcast, 400, .badRequest("failed")),
    ])
    private func remainingDocumentedFailures(_ c: (Route, Int, ShepherdError)) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub(c.0.method, c.0.path, status: c.1, json: try Fixtures.errorJSON("failed"))
        await #expect(throws: c.2) { try await c.0.call(client(server)) }
    }

    @Test func startUpNextPreservesFirstRunGate() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/up-next/start", status: 409,
                    json: try Fixtures.errorJSON("first_run_pending"))
        await #expect(throws: ShepherdError.firstRunPending) {
            _ = try await client(server).startUpNext(items: [startItem], choice: nil)
        }
    }

    @Test(arguments: [(Route.spawn, 201), (.start, 502), (.restore, 409)])
    private func malformedSpecialResponsesAreContractFailures(_ c: (Route, Int)) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub(c.0.method, c.0.path, status: c.1, json: Data(#"{}"#.utf8))
        do {
            try await c.0.call(client(server))
            Issue.record("Expected a decoding failure")
        } catch let error as ShepherdError {
            guard case .contractMismatch(let route, _) = error else {
                Issue.record("Unexpected failure: \(error)")
                return
            }
            #expect(route == c.0.operation)
        }
    }

    @Test(arguments: Route.allCases)
    private func cancellationIsPreserved(route: Route) async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.on(route.method, route.path) { _ in throw URLError(.cancelled) }
        await #expect(throws: ShepherdError.cancelled) { try await route.call(client(server)) }
    }
}
