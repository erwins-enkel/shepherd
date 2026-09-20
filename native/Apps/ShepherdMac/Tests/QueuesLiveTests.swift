// Read-only against real sessions and queues: halt interrupts every working agent,
// held-spawn starts one, and revive-stranded resumes several. Never issue those writes here.
// Authentication may mint a Shepherd UI test (…) token; cleanup revokes only that token.
// Password runs must forward SHEPHERD_LIVE_PASSWORD as SHEPHERD_LIVE_QUEUES_PASSWORD and
// unset both standard password spellings before launching the host. Otherwise LaunchEnvironment
// also signs in and sweeps prior test-named tokens, outside this suite's read-only boundary.
import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

private enum QueuesLiveGate {
    static var armed: Bool {
        LiveServerEnvironment.baseURL != nil
            && (password != nil || LiveServerEnvironment.token != nil)
    }

    static var password: String? {
        let environment = ProcessInfo.processInfo.environment
        for key in ["SHEPHERD_LIVE_QUEUES_PASSWORD", "TEST_RUNNER_SHEPHERD_LIVE_QUEUES_PASSWORD"] {
            if let value = environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines),
                !value.isEmpty
            {
                return value
            }
        }
        return nil
    }
}

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
        let client = try ShepherdClient(
            profile: profile, credentials: credentials, urlSession: session)

        var minted = false
        if let token = LiveServerEnvironment.token {
            try credentials.save(
                StoredCredential(token: token, tokenId: "live-queues"), for: profile.credentialKey)
        } else {
            let password = try #require(QueuesLiveGate.password)
            try await ProfileSetup.login(
                profile: profile, password: password, credentials: credentials,
                tokenName: ProfileSetup.tokenName(prefix: "Shepherd UI test ("))
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
