import Foundation
import Testing
@testable import ShepherdKit

@Suite(.timeLimit(.minutes(1)))
struct ShepherdClientHeavySlotTests {
    private func client(_ server: FakeShepherdServer) throws -> ShepherdClient {
        try ShepherdClient(profile: .init(name: "fixture", baseURL: server.baseURL, mode: .local),
            credentials: InMemoryCredentialStore(), urlSession: server.urlSession(), requestAttempts: 1)
    }

    @Test func readsHostSnapshotWithUnavailablePlatformMetrics() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("GET", "/api/heavy-slot") { _ in
            FakeResponse(body: Data(#"""
            {"enabled":true,"capacity":2,
             "holders":[{"sessionId":"s1","command":"swift build","startedAt":1000,"rssBytes":649068544}],
             "waiters":[{"sessionId":"s2","position":1,"reason":"pressure"}],
             "brake":{"active":true,"reason":"memory"},
             "pressure":{"ramAvailableBytes":1024,"ramTotalBytes":4096,"swapUsedBytes":null,"swapTotalBytes":null,"memFullAvg10":0.03,"memBrakeThreshold":20,"cpuSomeAvg10":null},
             "memoryBySource":{"agentsBytes":null,"foreignBytes":null,"foreignTop":[]},
             "lastResults":[{"sessionId":"s1","command":"swift test","startedAt":0,"endedAt":1,"exitCode":0,"result":"passed","head":"abcdef1234","treeHash":"hash","stale":true}]}
            """#.utf8))
        }
        let snapshot = try await client(server).heavySlot()
        #expect(snapshot.capacity == 2)
        #expect(snapshot.holders.first?.command == "swift build")
        #expect(snapshot.waiters.first?.reason == .pressure)
        #expect(snapshot.brake.active)
        #expect(snapshot.pressure.memFullAvg10 == 0.03)
        #expect(snapshot.pressure.swapUsedBytes == nil)
        #expect(snapshot.memoryBySource.agentsBytes == nil)
        #expect(snapshot.lastResults.first?.stale == true)
    }

    @Test(arguments: [401, 404, 503]) func errorsAreNotPresentedAsAnEmptyHost(_ status: Int) async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.on("GET", "/api/heavy-slot") { _ in FakeResponse(statusCode: status) }
        await #expect(throws: ShepherdError.self) { _ = try await client(server).heavySlot() }
    }
}
