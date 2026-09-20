import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

@MainActor struct MergeLiveTests {
    private enum LiveFailure: Error { case setup, read, revocation }

    @Test(.enabled(if: LiveServerEnvironment.configured || LiveServerEnvironment.tokenConfigured))
    func readOnlyOperatorServer() async throws {
        // Use the shared reader for both plain and TEST_RUNNER_ environment spellings.
        // A password-only environment is enough to mint a disposable test credential.
        let raw = try #require(LiveServerEnvironment.baseURL)
        let url = try RemoteServerForm.normalize(raw)
        let credentials = InMemoryCredentialStore()
        let profile = ServerProfile(name: "live-merge", baseURL: url,
            mode: .remote, credentialKey: "live-merge-\(UUID().uuidString)")
        var minted = false
        var revocationProbe: ShepherdClient?

        func cleanup() async throws {
            guard minted else { return } // Never revoke a supplied operator token.
            try await ProfileSetup.logout(profile: profile, credentials: credentials)
            guard let revocationProbe else { throw LiveFailure.revocation }
            do {
                _ = try await revocationProbe.listAutomerge()
            } catch ShepherdError.unauthenticated {
                print("live merge: minted test token revoked (401 verified)")
                return
            } catch { throw LiveFailure.revocation }
            throw LiveFailure.revocation
        }

        do {
            if let token = LiveServerEnvironment.token {
                try credentials.save(.init(token: token, tokenId: "external"), for: profile.credentialKey)
            } else {
                let password = try #require(LiveServerEnvironment.password)
                let credential = try await ProfileSetup.login(profile: profile, password: password,
                    credentials: credentials, tokenName: ProfileSetup.tokenName(
                        prefix: "Shepherd UI test (", hostName: "merge-\(UUID().uuidString)"))
                minted = true
                let probeCredentials = InMemoryCredentialStore()
                try probeCredentials.save(credential, for: profile.credentialKey)
                revocationProbe = try ShepherdClient(profile: profile, credentials: probeCredentials)
            }
            let client = try ShepherdClient(profile: profile, credentials: credentials)
            // Only GETs against merge state. No AppModel activation or queue recomputation.
            async let auto = client.listAutomerge()
            async let drain = client.listDrain()
            async let queues = client.listBuildQueues()
            async let owed = client.listOutstandingManualSteps()
            let result = try await (auto, drain, queues, owed)
            #expect(result.2.allSatisfy { $0.key == $0.value.sessionId })
            #expect(result.3.allSatisfy { $0.clearedAt == nil })
            print("live merge: \(result.0.count) automation, \(result.1.count) drain, \(result.2.count) queues, \(result.3.count) owed")
        } catch {
            try await cleanup()
            // Do not include server payloads, URLs or credentials in failure output.
            throw minted ? LiveFailure.read : LiveFailure.setup
        }
        try await cleanup()
    }
}
