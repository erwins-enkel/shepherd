import Foundation
import Testing
@testable import ShepherdKit
struct ShepherdClientMergeTests {
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
