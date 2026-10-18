import Foundation
import Testing
@testable import ShepherdKit

@Suite("ShepherdClient epic control")
struct ShepherdClientEpicControlTests {
    private let wire = Data(#"{"repoPath":"/repo space","parentIssueNumber":100,"parentTitle":"Epic","source":"native","children":[],"warnings":[],"run":{"repoPath":"/repo space","parentIssueNumber":100,"mode":"attended","status":"running"}}"#.utf8)
    private func client(_ server: FakeShepherdServer) throws -> ShepherdClient {
        let credentials = InMemoryCredentialStore()
        try credentials.save(.init(token: "fixture", tokenId: "fixture"), for: "epic")
        return try ShepherdClient(profile: .init(name: "fixture", baseURL: server.baseURL, mode: .local,
            credentialKey: "epic"), credentials: credentials, urlSession: server.urlSession())
    }
    @Test func updatesAndApprovalsEncodeRouteQueryAndSettings() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.stub("PUT", "/api/epic", status: 200, json: wire)
        server.stub("POST", "/api/epic/approve-next", status: 200, json: wire)
        let client = try client(server)
        let result = try await client.updateEpic(repoPath: "/repo space", parent: 100,
            patch: .init(mode: .attended, status: .running, agentProvider: .codex, model: "gpt-6-sol", effort: "high", ignoreUsageCeiling: true), requeueLeader: true)
        #expect(result.run.mode.value1 == .attended)
        #expect(try await client.approveEpicNext(repoPath: "/repo space", parent: 100) == result)
        let requests = server.requests()
        #expect(requests.map(\.method) == ["PUT", "POST"])
        for request in requests {
            let query = URLComponents(string: "http://fake/?\(request.query ?? "")")?.queryItems
            #expect(query?.first { $0.name == "repo" }?.value == "/repo space")
            #expect(query?.first { $0.name == "parent" }?.value == "100")
        }
        #expect(requests[0].query?.contains("requeueLeader=1") == true)
        #expect(requests[1].body == nil || requests[1].body?.isEmpty == true)
        let body = try #require(requests[0].body)
        let patch = try JSONDecoder().decode(Components.Schemas.EpicRunPatch.self, from: body)
        #expect(patch.status == .running && patch.mode == .attended)
        #expect(patch.agentProvider == .codex && patch.model == "gpt-6-sol" && patch.effort == "high")
        #expect(patch.ignoreUsageCeiling == true)
        _ = try await client.updateEpic(repoPath: "/repo space", parent: 100, patch: .init(status: .paused))
        #expect(server.requests().last?.query?.contains("requeueLeader") == false)
    }
    @Test func okOnlyResponsesRereadTheGraph() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.stub("PUT", "/api/epic", status: 200, json: Data(#"{"ok":true}"#.utf8))
        server.stub("POST", "/api/epic/approve-next", status: 200, json: Data(#"{"ok":true}"#.utf8))
        server.stub("GET", "/api/epic", status: 200, json: wire)
        let client = try client(server)
        #expect(try await client.updateEpic(repoPath: "/repo space", parent: 100, patch: .init()).parentIssueNumber == 100)
        #expect(try await client.approveEpicNext(repoPath: "/repo space", parent: 100).parentIssueNumber == 100)
        #expect(server.requests().map(\.method) == ["PUT", "GET", "POST", "GET"])
    }
    @Test func errorsPreserveConflictsAuthenticationAndUpstreamFailures() async throws {
        for status in [400, 401, 409, 503, 418] {
            let server = FakeShepherdServer(); defer { server.tearDown() }
            server.stub("PUT", "/api/epic", status: status, json: try Fixtures.errorJSON("another epic leads"))
            server.stub("POST", "/api/epic/approve-next", status: status, json: try Fixtures.errorJSON("another epic leads"))
            let client = try client(server)
            func expected(_ route: String) -> ShepherdError {
                switch status {
                case 400: .badRequest("another epic leads")
                case 401: .unauthenticated
                case 409 where route == "patchEpicRun": .conflict(code: nil, message: "another epic leads")
                case 503: .upstreamFailure(code: nil, message: "another epic leads")
                default: .contractMismatch(route: route, underlying: "undocumented status \(status)")
                }
            }
            await #expect(throws: expected("patchEpicRun")) { _ = try await client.updateEpic(repoPath: "/repo space", parent: 100, patch: .init(status: .paused)) }
            await #expect(throws: expected("approveEpicNext")) { _ = try await client.approveEpicNext(repoPath: "/repo space", parent: 100) }
        }
    }
    @Test func malformedOrDisappearedGraphDoesNotFabricateSuccess() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.stub("PUT", "/api/epic", status: 200, json: Data(#"{"unexpected":true}"#.utf8))
        server.stub("POST", "/api/epic/approve-next", status: 200, json: Data(#"{"ok":true}"#.utf8))
        server.stub("GET", "/api/epic", status: 404, json: try Fixtures.errorJSON("gone"))
        let client = try client(server)
        do {
            _ = try await client.updateEpic(repoPath: "/repo space", parent: 100, patch: .init())
            Issue.record("Malformed response accepted")
        } catch let error as ShepherdError {
            guard case .contractMismatch(let route, _) = error else { Issue.record("Unexpected error: \(error)"); return }
            #expect(route == "patchEpicRun")
        }
        await #expect(throws: ShepherdError.notFound) { _ = try await client.approveEpicNext(repoPath: "/repo space", parent: 100) }
    }
}
