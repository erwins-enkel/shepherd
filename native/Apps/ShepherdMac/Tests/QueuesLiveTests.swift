// Read-only against real sessions and queues: halt interrupts every working agent,
// held-spawn starts one, and revive-stranded resumes several. Never issue those writes here.
// Authentication may mint a Shepherd UI test (…) token; cleanup revokes only that token.
// Use SHEPHERD_LIVE_BASE_URL plus SHEPHERD_LIVE_PASSWORD (or SHEPHERD_LIVE_TOKEN), with
// TEST_RUNNER_ prefixes when launching through xcodebuild, like the other live suites.
// Set TEST_RUNNER_SHEPHERD_REVOKE_ON_EXIT=1 for the isolated host's own token cleanup.
// The host may seed/sweep its Shepherd UI test (…) tokens; this suite revokes only its own.
import Foundation
import ShepherdKit
import Testing

@testable import Shepherd
@testable import ShepherdAppCore

private enum QueuesLiveGate {
    static var armed: Bool {
        LiveServerEnvironment.baseURL != nil
            && (LiveServerEnvironment.password != nil || LiveServerEnvironment.token != nil)
    }
}

extension MacSeamTests {
@MainActor
struct QueuesLiveTests {
    @Test("queue snapshots decode against the real server", .enabled(if: QueuesLiveGate.armed))
    func queueSnapshotsDecodeAgainstTheRealServer() async {
        // Never let a transport error print a live URL, credential, or response body.
        do {
            try await checkSnapshots()
        } catch {
            Issue.record("Live queue snapshot check failed; connection details are withheld.")
        }
    }

    private func checkSnapshots() async throws {
        let raw = try #require(LiveServerEnvironment.baseURL)
        let url = try RemoteServerForm.normalize(raw)
        let credentials = InMemoryCredentialStore()
        let profile = try ServerProfile(
            name: "live-queues", baseURL: url, mode: .remote, credentialKey: "live-queues"
        ).validated()
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let audit = ReadOnlyRequestAudit()
        defer { #expect(audit.counts.reads > 0); #expect(audit.counts.rejected == 0) }
        let client = try ShepherdClient(
            profile: profile, credentials: credentials, urlSession: session, readOnlyAudit: audit)

        var minted = false
        if let token = LiveServerEnvironment.token {
            try credentials.save(
                StoredCredential(token: token, tokenId: "live-queues"), for: profile.credentialKey)
        } else {
            let password = try #require(LiveServerEnvironment.password)
            // The host sweeps its exact machine-based test name while starting. Give this
            // suite a distinct name so that concurrent seed cannot revoke our fresh token.
            try await ProfileSetup.login(
                profile: profile, password: password, credentials: credentials,
                tokenName: ProfileSetup.tokenName(prefix: "Shepherd UI test (",
                                                hostName: "queues-\(UUID().uuidString)"))
            minted = true
        }

        do {
            let held = try await client.heldTasks()
            let stranded = try await client.strandedSessions()
            let done = try await client.doneSessions()
            let recaps = try await client.recaps()
            // Empty snapshots are valid. Compare booleans so a failure cannot dump live rows.
            let allDoneAreArchived = done.allSatisfy { $0.archivedAt != nil }
            let allRecapKeysMatch = recaps.allSatisfy { $0.key == $0.value.sessionId }
            #expect(allDoneAreArchived, "Every done session must have archivedAt.")
            #expect(allRecapKeysMatch, "Every recap key must equal its sessionId.")
            print(
                "live queues: \(held.count) held, \(stranded.count) stranded, "
                    + "\(done.count) done, \(recaps.count) recaps")
        } catch {
            await cleanup(profile: profile, credentials: credentials, minted: minted)
            throw error
        }
        await cleanup(profile: profile, credentials: credentials, minted: minted)
    }

    private func cleanup(
        profile: ServerProfile, credentials: InMemoryCredentialStore, minted: Bool
    ) async {
        // No sweep by name and no logout for a caller-owned token.
        guard minted else { return }
        do {
            try await ProfileSetup.logout(profile: profile, credentials: credentials)
        } catch {
            Issue.record("Could not revoke the token minted by this live queue test.")
        }
    }
}
}
