import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

@MainActor
struct SettingsLiveTests {
    private enum LiveFailure: Error { case read, revocation }

    @Test(.enabled(if: LiveServerEnvironment.tokenConfigured || LiveServerEnvironment.configured))
    func readOnlyOperatorServer() async throws {
        guard let raw = LiveServerEnvironment.baseURL else { return }
        let url = try RemoteServerForm.normalize(raw)
        let credentials = InMemoryCredentialStore()
        let profile = ServerProfile(name: "live-settings", baseURL: url,
                                    mode: .remote, credentialKey: "live-settings")
        var minted = false
        var revocationProbe: ShepherdClient?
        func cleanup() async throws {
            guard minted else { return }
            do {
                try await ProfileSetup.logout(profile: profile, credentials: credentials)
                guard let revocationProbe else { throw LiveFailure.revocation }
                do { _ = try await revocationProbe.repos() }
                catch ShepherdError.unauthenticated {
                    print("settings live: minted test token revoked (401 verified)")
                    return
                }
            } catch { throw LiveFailure.revocation }
            throw LiveFailure.revocation
        }
        let audit = ReadOnlyRequestAudit()
        defer {
            #expect(audit.counts.reads >= 4)
            #expect(audit.counts.rejected == 0, "settings smoke must attempt only GET requests")
        }
        do {
            if let token = LiveServerEnvironment.token {
                try credentials.save(.init(token: token, tokenId: "external"), for: profile.credentialKey)
            } else {
                guard let password = LiveServerEnvironment.password else { throw LiveFailure.read }
                let credential = try await ProfileSetup.login(profile: profile, password: password,
                    credentials: credentials, tokenName: ProfileSetup.tokenName(
                        prefix: "Shepherd UI test (", hostName: "settings-\(UUID())"))
                minted = true
                let probeCredentials = InMemoryCredentialStore()
                try probeCredentials.save(credential, for: profile.credentialKey)
                revocationProbe = try ShepherdClient(profile: profile, credentials: probeCredentials)
            }
            let client = try ShepherdClient(profile: profile, credentials: credentials, readOnlyAudit: audit)
            let settings = try await client.settings()
            let diagnostics = try await client.getDiagnostics()
            let directories = try await client.listDirectories()
            #expect(!settings.repoRoot.isEmpty)
            #expect(diagnostics.generatedAt >= 0)
            #expect(!directories.path.isEmpty)
            let repos = try await client.repos()
            if let repo = repos.repos.first {
                _ = try await client.getRepoConfig(repo: repo.path)
                _ = try await client.getRepoRoles(repo: repo.path)
                _ = try await client.getRepoCollaborators(repo: repo.path)
                #expect(audit.counts.reads >= 7)
            }
            print("settings live audit passed: \(audit.counts.reads) GET requests; \(audit.counts.rejected) rejected")
        } catch {
            try await cleanup()
            // Generated client errors can contain URLs or payloads. Keep live output value-free.
            throw LiveFailure.read
        }
        try await cleanup()
    }
}
