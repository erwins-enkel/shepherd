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
