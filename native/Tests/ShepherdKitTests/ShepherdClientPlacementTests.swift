import Foundation
import Testing
@testable import ShepherdKit

/// The machine choice on the wire (#2776): the placement preview, the requirements read from a
/// task, the keyed create and the tasks for connected machines that are not settled.
@Suite("ShepherdClient machine choice", .timeLimit(.minutes(1)))
struct ShepherdClientPlacementTests {
    private func makeClient(_ server: FakeShepherdServer) throws -> ShepherdClient {
        let credentials = InMemoryCredentialStore()
        try credentials.save(StoredCredential(token: "shp_test", tokenId: "tok"), for: "k")
        let profile = ServerProfile(name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
        return try ShepherdClient(profile: profile, credentials: credentials, urlSession: server.urlSession())
    }

    private func json(_ request: RecordedRequest) throws -> [String: Any] {
        let body = try #require(request.body)
        return try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    private func header(_ request: RecordedRequest, _ name: String) -> String? {
        request.headers.first { $0.key.lowercased() == name }?.value
    }

    private static let mac = #"{"instanceId":"mac","name":"MacBook","platform":"macos"}"#
    private static let linux = #"{"instanceId":"linux","name":"moes-tavern","platform":"linux"}"#
    private static let waiting = #"{"id":"d1","state":"waiting","host":\#(mac),"summary":"Fix the iOS build","createdAt":1,"updatedAt":2,"readiness":{"state":"offline","status":"timeout"},"alternatives":[\#(linux)]}"#

    @Test func previewDecodesTheChoiceAndTheMachinesAndAnOldServerIsNotFound() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/placement", status: 200, json: Data(#"""
            {"active":true,"deriveRequirements":true,"machines":[\#(Self.linux),\#(Self.mac)],
             "placement":{"mode":"auto","target":\#(Self.mac),"requirements":["xcode"],"basis":"requirements",
              "preferred":null,"by":{"instanceId":"linux","name":"moes-tavern"},"decidedAt":1}}
            """#.utf8))
        let client = try makeClient(server)
        let preview = try await client.previewPlacement(.init(
            repoPath: "/repo", requirements: [Capability(id: "xcode")], target: .init(instanceId: "mac")))
        #expect(preview.active)
        #expect(preview.deriveRequirements == true)
        #expect(preview.machines?.map(\.instanceId) == ["linux", "mac"])
        #expect(preview.placement?.basis.rawValue == "requirements")
        #expect(preview.placement?.requirements.map(\.rawValue) == ["xcode"])
        let body = try json(try #require(server.requests().last))
        #expect(body["repoPath"] as? String == "/repo")
        #expect(body["requirements"] as? [String] == ["xcode"])
        #expect((body["target"] as? [String: Any])?["instanceId"] as? String == "mac")

        server.stub("POST", "/api/placement", status: 404, json: try Fixtures.errorJSON("not found"))
        await #expect(throws: ShepherdError.notFound) {
            _ = try await client.previewPlacement(.init(repoPath: "/repo"))
        }
    }

    @Test func derivationDecodesTheQuestionAndTheFailure() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/requirements/derive", status: 200,
                    json: Data(#"{"status":"unclear","options":[["xcode"],[]]}"#.utf8))
        let client = try makeClient(server)
        let unclear = try await client.deriveRequirements(.init(
            repoPath: "/repo", prompt: "fix the app", issue: .init(title: "App crashes", body: "on launch")))
        #expect(unclear.status.rawValue == "unclear")
        #expect(unclear.options?.map { $0.map(\.rawValue) } == [["xcode"], []])
        let body = try json(try #require(server.requests().last))
        #expect((body["issue"] as? [String: Any])?["title"] as? String == "App crashes")

        server.stub("POST", "/api/requirements/derive", status: 200,
                    json: Data(#"{"status":"failed","cause":"timeout"}"#.utf8))
        let failed = try await client.deriveRequirements(.init(repoPath: "/repo", prompt: "x"))
        #expect(failed.status.rawValue == "failed")
        #expect(failed.cause?.rawValue == "timeout")
    }

    @Test func aCreateCarriesTheKeyOnlyWhenGivenAndNoMachineUnlessNamed() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("POST", "/api/sessions", status: 201, json: try Fixtures.minimalSessionJSON())
        let client = try makeClient(server)
        var request = CreateSessionRequest(repoPath: "/repo", baseBranch: "main", prompt: "Fix", agentProvider: .claude)
        request.requirements = [Capability(id: "xcode")]
        _ = try await client.createSession(request, spawnID: "spawn-1", idempotencyKey: "key-1")
        _ = try await client.createSession(request, spawnID: "spawn-2")
        let requests = server.requests()
        #expect(header(requests[0], "idempotency-key") == "key-1")
        #expect(header(requests[1], "idempotency-key") == nil)
        let automatic = try json(requests[0])
        #expect(automatic["target"] == nil, "Automatic leaves the machine to the server")
        #expect(automatic["requirements"] as? [String] == ["xcode"])

        request.target = .init(instanceId: "mac")
        _ = try await client.createSession(request, spawnID: "spawn-3", idempotencyKey: "key-2")
        let named = try json(try #require(server.requests().last))
        #expect((named["target"] as? [String: Any])?["instanceId"] as? String == "mac")
    }

    @Test func machineRefusalsKeepTheirFieldsAndOtherFailuresStayAsTheyWere() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        let client = try makeClient(server)
        let request = CreateSessionRequest(repoPath: "/repo", baseBranch: "main", prompt: "Fix", agentProvider: .claude)
        func create() async throws { _ = try await client.createSession(request, spawnID: "s") }

        server.stub("POST", "/api/sessions", status: 422, json: Data(#"""
            {"error":"no machine","code":"no_suitable_machine","missing":["xcode","sdk:ios"],"together":true,
             "elsewhere":[\#(Self.mac)]}
            """#.utf8))
        await #expect(throws: MachineRefusal(
            code: "no_suitable_machine", error: "no machine", together: true,
            elsewhere: [SessionHost(instanceId: "mac", name: "MacBook", platform: InstancePlatform(known: .macos))],
            missing: [.init(capability: "xcode"), .init(capability: "sdk:ios")])) { try await create() }

        server.stub("POST", "/api/sessions", status: 422, json: Data(#"""
            {"error":"missing","code":"missing_capabilities","host":\#(Self.mac),
             "missing":[{"capability":"xcode","reason":"license_not_accepted"}]}
            """#.utf8))
        do {
            try await create()
            Issue.record("expected a refusal")
        } catch let refusal as MachineRefusal {
            #expect(refusal.host?.name == "MacBook")
            #expect(refusal.missing == [.init(capability: "xcode", reason: "license_not_accepted")])
        }

        server.stub("POST", "/api/sessions", status: 422, json: try Fixtures.errorJSON("base branch not found"))
        await #expect(throws: ShepherdError.unprocessable("base branch not found")) { try await create() }
        server.stub("POST", "/api/sessions", status: 502,
                    json: try Fixtures.errorJSON("photo.png: refused", code: "remote_upload_failed"))
        await #expect(throws: ShepherdError.upstreamFailure(code: "remote_upload_failed", message: "photo.png: refused")) {
            try await create()
        }
        server.stub("POST", "/api/sessions", status: 502, json: try Fixtures.errorJSON("git failed", code: "spawn_failed"))
        await #expect(throws: ShepherdError.upstreamFailure(code: nil, message: "git failed")) { try await create() }
        server.stub("POST", "/api/sessions", status: 409,
                    json: try Fixtures.errorJSON("not reachable", code: "remote_target_unavailable"))
        await #expect(throws: ShepherdError.conflict(code: "remote_target_unavailable", message: "not reachable")) {
            try await create()
        }
    }

    @Test func dispatchesAreListedCanceledAndRedirected() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.stub("GET", "/api/remote-dispatches", status: 200, json: Data(#"{"dispatches":[\#(Self.waiting)]}"#.utf8))
        let client = try makeClient(server)
        let listed = try await client.remoteDispatches()
        #expect(listed.map(\.id) == ["d1"])
        #expect(listed[0].state.rawValue == "waiting")
        #expect(listed[0].readiness?.state.rawValue == "offline")
        #expect(listed[0].alternatives?.map(\.name) == ["moes-tavern"])

        server.stub("DELETE", "/api/remote-dispatches/d1", status: 200, json: Data(Self.waiting.utf8))
        #expect(try await client.cancelRemoteDispatch(id: "d1") == .canceled(listed[0]))
        server.stub("DELETE", "/api/remote-dispatches/d1", status: 202, json: Data(Self.waiting.utf8))
        #expect(try await client.cancelRemoteDispatch(id: "d1") == .pending(listed[0]))
        server.stub("DELETE", "/api/remote-dispatches/d1", status: 409, json: Data(#"""
            {"error":"not cancelable","code":"remote_dispatch_not_cancelable","dispatch":\#(Self.waiting)}
            """#.utf8))
        await #expect(throws: RemoteDispatchConflict(code: "remote_dispatch_not_cancelable", dispatch: listed[0])) {
            _ = try await client.cancelRemoteDispatch(id: "d1")
        }

        server.stub("POST", "/api/remote-dispatches/d1/redirect", status: 201, json: try Fixtures.minimalSessionJSON())
        guard case .created = try await client.redirectRemoteDispatch(id: "d1", to: "linux") else {
            Issue.record("expected a session"); return
        }
        let body = try json(try #require(server.requests().last))
        #expect((body["target"] as? [String: Any])?["instanceId"] as? String == "linux")
        server.stub("POST", "/api/remote-dispatches/d1/redirect", status: 200,
                    json: Data(#"{"held":true,"waiting":true,"id":"d1","count":1,"host":\#(Self.mac)}"#.utf8))
        guard case .held(let held) = try await client.redirectRemoteDispatch(id: "d1", to: "mac") else {
            Issue.record("expected a wait"); return
        }
        #expect(held.waiting == true)
        server.stub("POST", "/api/remote-dispatches/d1/redirect", status: 422, json: Data(#"""
            {"error":"missing","code":"missing_capabilities","host":\#(Self.linux),"missing":[{"capability":"xcode","reason":"not_installed"}]}
            """#.utf8))
        await #expect(throws: MachineRefusal.self) { _ = try await client.redirectRemoteDispatch(id: "d1", to: "linux") }
        server.stub("POST", "/api/remote-dispatches/d1/redirect", status: 409,
                    json: try Fixtures.errorJSON("not waiting", code: "remote_dispatch_not_redirectable"))
        await #expect(throws: RemoteDispatchConflict(code: "remote_dispatch_not_redirectable", dispatch: nil)) {
            _ = try await client.redirectRemoteDispatch(id: "d1", to: "linux")
        }
    }
}
