import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

struct MergeLiveTests {
    @Test func readOnlyOperatorServer() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let raw = env["SHEPHERD_LIVE_BASE_URL"],
              let token = env["SHEPHERD_LIVE_TOKEN"], !token.isEmpty else { return }
        let url = try RemoteServerForm.normalize(raw)
        let credentials = InMemoryCredentialStore()
        try credentials.save(.init(token: token, tokenId: "external"), for: "live")
        let client = try ShepherdClient(profile: .init(name: "live", baseURL: url,
            mode: .remote, credentialKey: "live"), credentials: credentials)
        async let auto = client.listAutomerge()
        async let drain = client.listDrain()
        async let queues = client.listBuildQueues()
        async let owed = client.listOutstandingManualSteps()
        let result = try await (auto, drain, queues, owed)
        #expect(result.2.allSatisfy { $0.key == $0.value.sessionId })
        #expect(result.3.allSatisfy { $0.clearedAt == nil })
    }
}
