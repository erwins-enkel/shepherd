import Foundation
import Testing
@testable import ShepherdKit

struct ShepherdClientQueuesTests {
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
