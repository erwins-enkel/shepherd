import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

/// Read-only against real repositories and sessions. Never submit, shape, upload, or repair.
/// Authentication may mint only our own named test token; cleanup revokes only that token.
@MainActor
struct ComposeLiveTests {
    private enum LiveFailure: Error { case setup, read, revocation }

    @Test("live issues, both command providers and branches decode for every repository",
          .enabled(if: LiveServerEnvironment.configured || LiveServerEnvironment.tokenConfigured))
    func composerReadsEveryLiveRepository() async throws {
        let credentials = InMemoryCredentialStore()
        var profile: ServerProfile?
        var stage = "authentication"
        var minted = false
        var revocationProbe: ShepherdClient?

        func cleanup() async throws {
            guard minted, let profile else { return } // A supplied token belongs to the caller.
            do {
                try await ProfileSetup.logout(profile: profile, credentials: credentials)
                guard let revocationProbe else { throw LiveFailure.revocation }
                do {
                    _ = try await revocationProbe.repos()
                } catch ShepherdError.unauthenticated {
                    print("live compose: minted test token revoked (401 verified)")
                    return
                }
                throw LiveFailure.revocation
            } catch { throw LiveFailure.revocation }
        }

        do {
            guard let raw = LiveServerEnvironment.baseURL else { throw LiveFailure.setup }
            let live = try ServerProfile(name: "live-compose", baseURL: RemoteServerForm.normalize(raw),
                mode: .remote, credentialKey: "live-compose-\(UUID())").validated()
            profile = live
            if let token = LiveServerEnvironment.token {
                try credentials.save(.init(token: token, tokenId: "live-compose-supplied"),
                                     for: live.credentialKey)
            } else {
                guard let password = LiveServerEnvironment.password else { throw LiveFailure.setup }
                let credential = try await ProfileSetup.login(profile: live, password: password,
                    credentials: credentials, tokenName: ProfileSetup.tokenName(
                        prefix: "Shepherd UI test (", hostName: "compose-\(UUID())"))
                minted = true
                let probeCredentials = InMemoryCredentialStore()
                try probeCredentials.save(credential, for: live.credentialKey)
                revocationProbe = try ShepherdClient(profile: live, credentials: probeCredentials)
            }
            let client = try ShepherdClient(profile: live, credentials: credentials)
            stage = "repositories"
            let repos = try await client.repos().repos
            #expect(!repos.isEmpty, "Live coverage requires at least one repository")
            var issueCount = 0, issueReads = 0, commandCount = 0, commandReads = 0, branchReads = 0
            var unavailableIssues = 0, unavailableBranches = 0
            for (index, repo) in repos.enumerated() {
                stage = "issues for repository \(index + 1)"
                var listing: IssueListing?
                do {
                    listing = try await client.issues(repoPath: repo.path)
                    issueReads += 1
                } catch ShepherdError.badRequest(let reason) where reason == "invalid repo" {
                    // The repo index can retain entries rejected by safeRepoDir. Keep reading
                    // every listed repo and exercise the other routes; never repair live data.
                    unavailableIssues += 1
                }
                for issue in listing?.issues ?? [] {
                    let hasNumber = issue.number > 0
                    let url = URL(string: issue.url)
                    let hasURL = (url?.scheme == "http" || url?.scheme == "https") && url?.host != nil
                    // Assert only booleans: failures must not print live URLs or payloads.
                    #expect(hasNumber, "An issue must have a positive number")
                    #expect(hasURL, "An issue must have an HTTP(S) URL")
                    issueCount += 1
                }
                for provider in [AgentProvider.claude, .codex] {
                    stage = "\(provider.rawValue) commands for repository \(index + 1)"
                    commandCount += try await client.commands(repoPath: repo.path, provider: provider).commands.count
                    commandReads += 1
                }
                stage = "branches for repository \(index + 1)"
                do {
                    _ = try await client.branches(repoPath: repo.path)
                    branchReads += 1
                } catch ShepherdError.badRequest(let reason) where reason == "invalid repo" {
                    unavailableBranches += 1
                }
            }
            #expect(commandReads == repos.count * 2)
            #expect(issueReads + unavailableIssues == repos.count)
            #expect(branchReads + unavailableBranches == repos.count)
            #expect(issueReads > 0 && branchReads > 0, "Live coverage requires successful listings")
            print("live compose: unavailable listings (documented invalid-repo 400): issues=\(unavailableIssues), branches=\(unavailableBranches)")
            print("live compose: \(repos.count) repositories, \(issueCount) issues checked, \(commandReads) command reads (\(commandCount) commands), \(branchReads) branch listings decoded")
        } catch {
            let category: String
            switch error as? ShepherdError {
            case .contractMismatch: category = "contract mismatch"
            case .badRequest: category = "bad request"
            case .unauthenticated: category = "unauthenticated"
            case .notFound: category = "not found"
            case .transport: category = "transport"
            default: category = "read failure"
            }
            print("live compose: failed during \(stage) (\(category))")
            try await cleanup()
            // Never expose a host, credential, server payload, or underlying network error.
            throw minted ? LiveFailure.read : LiveFailure.setup
        }
        try await cleanup()
    }
}
