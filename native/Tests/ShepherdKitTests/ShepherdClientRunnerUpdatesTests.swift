import Foundation
import Testing
@testable import ShepherdKit

@Suite(.timeLimit(.minutes(1)))
struct ShepherdClientRunnerUpdatesTests {
    private func client(_ server: FakeShepherdServer) throws -> ShepherdClient {
        try ShepherdClient(profile: .init(name: "fixture", baseURL: server.baseURL, mode: .local),
            credentials: InMemoryCredentialStore(), urlSession: server.urlSession())
    }
    @Test func readsNullableStatusAndReleaseNotes() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        for path in ["/api/herdr-update", "/api/codex-update"] {
            server.on("GET", path) { _ in FakeResponse(body: Data(#"{"current":null,"latest":null,"updateAvailable":false,"notes":null,"checkedAt":1}"#.utf8)) }
        }
        server.on("GET", "/api/codex-update/notes") { _ in FakeResponse(body: Data(#"{"current":null,"latest":null,"notes":[],"complete":false}"#.utf8)) }
        let client = try client(server)
        #expect(try await client.getHerdrUpdate().runtime == nil)
        #expect(try await client.getCodexUpdate().current == nil)
        #expect(try await client.getCodexReleaseNotes().complete == false)
    }
    @Test func actionsUseExistingRoutesAndRestartUsesDisplayedRuntime() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        for path in ["/api/herdr-update", "/api/herdr-update/downgrade", "/api/herdr-update/downgrade/sandbox", "/api/codex-update"] {
            server.on("POST", path) { _ in FakeResponse(statusCode: 202, body: Data(#"{"ok":true}"#.utf8)) }
        }
        server.on("POST", "/api/herdr-update/restart") { request in
            let data = try #require(request.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body.count == 3 && body["confirmed"] as? Bool == true)
            #expect(body["installedVersion"] as? String == "0.9.3")
            #expect(body["serverVersion"] as? String == "0.8.2" || body["serverVersion"] is NSNull)
            return FakeResponse(statusCode: 202, body: Data(#"{"ok":true}"#.utf8))
        }
        let client = try client(server)
        try await client.applyHerdrUpdate(); try await client.applyHerdrDowngrade()
        try await client.applyHerdrSandboxDowngrade(); try await client.applyCodexUpdate()
        try await client.restartHerdrServer(installedVersion: "0.9.3", serverVersion: "0.8.2")
        try await client.restartHerdrServer(installedVersion: "0.9.3", serverVersion: nil)
    }
    @Test(arguments: [400, 401, 403, 409, 503]) func errorsAreNotAcceptedAsSuccess(_ status: Int) async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("POST", "/api/herdr-update/restart") { _ in FakeResponse(statusCode: status, body: Data(#"{"error":"runtime_changed","code":"runtime_changed"}"#.utf8)) }
        await #expect(throws: ShepherdError.self) {
            try await client(server).restartHerdrServer(installedVersion: "0.9.3", serverVersion: nil)
        }
    }
    @Test func updateEventsReachTheExistingStreamTap() throws {
        for name in ["herdr-update:status", "herdr-update:log", "herdr-update:done",
                     "codex-update:status", "codex-update:log", "codex-update:done"] {
            let data = Data(("{\"event\":\"" + name + "\",\"data\":{\"line\":\"fixture\"}}").utf8)
            let event = try JSONDecoder().decode(ServerEvent.self, from: data)
            guard case .unknown(let decoded, let payload) = event else { Issue.record("update was consumed by the session store"); continue }
            #expect(decoded == name)
            let log = try JSONDecoder().decode(Components.Schemas.RunnerUpdateLog.self, from: try #require(payload))
            #expect(log.line == "fixture")
        }
    }
    @Test func alreadyRunning409HasOnlyOkAndOldEndpointIsUnavailable() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("POST", "/api/codex-update") { _ in FakeResponse(statusCode: 409, body: Data(#"{"ok":false}"#.utf8)) }
        server.on("GET", "/api/herdr-update") { _ in FakeResponse(statusCode: 404, body: Data(#"{"error":"not found"}"#.utf8)) }
        await #expect(throws: ShepherdError.conflict(code: "runner_update_not_started", message: "update not started")) { try await client(server).applyCodexUpdate() }
        await #expect(throws: ShepherdError.notFound) { _ = try await client(server).getHerdrUpdate() }
    }
}
