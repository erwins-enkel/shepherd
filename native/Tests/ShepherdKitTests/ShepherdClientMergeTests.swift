import Foundation
import Testing
@testable import ShepherdKit
struct ShepherdClientMergeTests {
    @Test func mergeCarriesTheConfirmedRevisionAndResponsibility() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("POST", "/api/sessions/a/git/merge") { request in
            let data = try #require(request.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body["method"] as? String == "squash")
            #expect(body["deleteBranch"] as? Bool == false)
            let confirm = try #require(body["confirm"] as? [String: Any])
            #expect(confirm["headSha"] as? String == "head-a")
            #expect(confirm["baseRefName"] as? String == "release")
            #expect(confirm["handoff"] as? String == "merger")
            #expect(confirm["handoffWho"] as? String == "owner")
            #expect(confirm["reviewBlockBy"] as? String == "reviewer")
            return FakeResponse(body: Data(#"{"state":"merged","checks":"success","deployConfigured":false}"#.utf8))
        }
        let result = try await client(server).mergePR(sessionID: "a", method: .squash,
            deleteBranch: false, confirm: .init(headSha: "head-a", baseRefName: "release",
                handoff: .merger, handoffWho: "owner", reviewBlockBy: "reviewer"))
        #expect(result.state.known == .merged)
        #expect(server.requests().count == 1)
    }
    @Test func staleMergeConfirmationIsRefusedWithoutRetry() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("POST", "/api/sessions/a/git/merge") { _ in
            FakeResponse(statusCode: 409, body: Data(
                #"{"error":"confirmation is stale","code":"merge_confirm_stale"}"#.utf8))
        }
        await #expect(throws: ShepherdError.conflict(code: "merge_confirm_stale", message: "confirmation is stale")) {
            _ = try await client(server).mergePR(sessionID: "a", method: .squash,
                deleteBranch: false, confirm: .init(headSha: "head-old"))
        }
        #expect(server.requests().count == 1)
    }
    @Test(arguments: [true, false, nil] as [Bool?])
    func automationOverridesPreserveAllThreeValues(_ enabled: Bool?) async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        for name in ["autopilot", "automerge"] {
            server.on("PUT", "/api/sessions/a/\(name)") { request in
                let data = try #require(request.body)
                let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                if let enabled {
                    #expect(body["enabled"] as? Bool == enabled)
                } else {
                    #expect(body["enabled"] is NSNull)
                }
                return FakeResponse(body: try Fixtures.json(Fixtures.session(id: "a")))
            }
        }
        let client = try client(server)
        _ = try await client.setSessionAutopilot(id: "a", body: .value(enabled))
        _ = try await client.setSessionAutomerge(id: "a", body: .value(enabled))
        #expect(server.requests().count == 2)
    }
    func client(_ server: FakeShepherdServer) throws -> ShepherdClient {
        let credentials = InMemoryCredentialStore()
        try credentials.save(.init(token: "shp_test", tokenId: "test"), for: "merge")
        return try ShepherdClient(profile: .init(name: "fake", baseURL: server.baseURL,
            mode: .local, credentialKey: "merge"), credentials: credentials,
            urlSession: server.urlSession())
    }
    @Test func explicitNullIsSentToInherit() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.on("PUT", "/api/sessions/a/autopilot") { req in
            let data = try #require(req.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body["enabled"] is NSNull)
            return FakeResponse(body: try Fixtures.json(Fixtures.session(id: "a")))
        }
        _ = try await client(server).setSessionAutopilot(id: "a", body: .value(nil))
        #expect(server.requests().count == 1)
    }
    @Test func redeployFailureHasTheRealStatusMapping() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.on("POST", "/api/sessions/a/git/redeploy") { _ in
            FakeResponse(statusCode: 400, body: Data(#"{"error":"no deploy workflow configured"}"#.utf8))
        }
        await #expect(throws: ShepherdError.badRequest("no deploy workflow configured")) {
            _ = try await client(server).redeploySession(id: "a")
        }
    }
    @Test func clearEmptyListCannotBecomeClearAll() async throws {
        let server = FakeShepherdServer()
        defer { server.tearDown() }
        server.on("POST", "/api/sessions/clear-merged") { req in
            let data = try #require(req.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body["ids"] as? [String] == [])
            return FakeResponse(body: Data(#"{"cleared":[],"leftovers":0}"#.utf8))
        }
        let result = try await client(server).clearMergedSessions(body: .init(ids: []))
        #expect(result.cleared.isEmpty)
    }
}
