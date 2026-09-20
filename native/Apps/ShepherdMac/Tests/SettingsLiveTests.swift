import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

struct SettingsLiveTests {
    private enum LiveFailure: Error { case read }

    @Test(.enabled(if: LiveServerEnvironment.tokenConfigured))
    func readOnlyOperatorServer() async throws {
        // The shared reader accepts both ordinary and TEST_RUNNER_ spellings.
        // This suite never mints or revokes an environment-provided credential.
        guard let raw = LiveServerEnvironment.baseURL,
              let token = LiveServerEnvironment.token else { return }
        let audit = ReadOnlyRequestAudit()
        defer {
            #expect(audit.counts.reads >= 4)
            #expect(audit.counts.rejected == 0, "settings smoke must attempt only GET requests")
        }
        do {
            let url = try RemoteServerForm.normalize(raw)
            let credentials = InMemoryCredentialStore()
            try credentials.save(.init(token: token, tokenId: "external"), for: "live")
            let client = try ShepherdClient(profile: .init(name: "live", baseURL: url,
                mode: .remote, credentialKey: "live"), credentials: credentials, readOnlyAudit: audit)
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
            // Generated client errors can contain URLs or payloads. Keep live output value-free.
            throw LiveFailure.read
        }
    }
}
