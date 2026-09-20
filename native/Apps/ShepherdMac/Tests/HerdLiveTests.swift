import Foundation
import OSLog
import ShepherdKit
import Testing

@testable import Shepherd

private enum HerdLiveGate {
    static var armed: Bool {
        LiveServerEnvironment.configured || LiveServerEnvironment.tokenConfigured
    }
}

/// Read-only snapshots and classification. Never triggers a critic or changes a real session.
/// CI skips both tests; credentials stay in memory and tokens minted here are given back.
@MainActor
@Suite(.serialized)
struct HerdLiveTests {
    private func withLiveStore(
        _ body: (SessionStore) async throws -> Void
    ) async throws {
        let address = try #require(LiveServerEnvironment.baseURL)
        let url = try RemoteServerForm.normalize(address)
        let credentials = InMemoryCredentialStore()
        let profile = try ServerProfile(
            name: "live herd", baseURL: url, mode: .remote, credentialKey: "live-herd"
        ).validated()
        var minted = false
        var store: SessionStore?
        func done() async {
            store?.stop()
            if minted {
                try? await ProfileSetup.logout(profile: profile, credentials: credentials)
            }
        }

        do {
            if let token = LiveServerEnvironment.token {
                try credentials.save(
                    StoredCredential(token: token, tokenId: "live-herd"),
                    for: profile.credentialKey)
            } else {
                let password = try #require(LiveServerEnvironment.password)
                try await ProfileSetup.login(
                    profile: profile, password: password, credentials: credentials,
                    tokenName: ProfileSetup.tokenName(
                        prefix: "Shepherd UI test (", hostName: "herd-\(UUID().uuidString)"))
                minted = true
            }
            let audit = ReadOnlyRequestAudit()
            defer { #expect(audit.counts.reads > 0); #expect(audit.counts.rejected == 0) }
            let live = try SessionStore(client: ShepherdClient(profile: profile, credentials: credentials,
                readOnlyAudit: audit))
            store = live
            try await body(live)
        } catch {
            await done()
            throw error
        }
        await done()
    }

    @Test("the herd snapshots decode against the real server", .enabled(if: HerdLiveGate.armed))
    func theHerdSnapshotsDecodeAgainstTheRealServer() async throws {
        try await withLiveStore { store in
            let git = try await store.client.gitStates()
            let reviews = try await store.client.reviews()
            let inflight = try await store.client.reviewsInflight()
            let activity = try await store.client.activityStates()
            let alive = try await store.client.claudeAliveStates()
            for (id, verdict) in reviews {
                #expect(verdict.sessionId == id || !verdict.sessionId.isEmpty)
            }
            for row in inflight { #expect(!row.id.isEmpty) }
            for (_, row) in git where row.state.known == .open {
                #expect(row.number != nil)
            }
            print("live herd snapshots: git=\(git.count), reviews=\(reviews.count), inflight=\(inflight.count), activity=\(activity.count), alive=\(alive.count)")
        }
    }

    @Test("every live session classifies without crashing", .enabled(if: HerdLiveGate.armed))
    func everySessionClassifiesWithoutCrashing() async throws {
        try await withLiveStore { store in
            try await store.bootstrap()
            let git = try await store.client.gitStates()
            var stages: Set<HerdStage> = []
            for session in store.sessions {
                stages.insert(HerdClassifier.stage(session, git: git[session.id], ctx: .idle))
            }
            #expect(!store.sessions.isEmpty, "the live server should have sessions")
            let names = stages.map(\.rawValue).sorted().joined(separator: ",")
            Log.ui.info("live herd stages: \(names, privacy: .public)")
            // Counts and stage names only: no operator hostname, session id or credentials.
            print("live herd: \(store.sessions.count) session(s); stages=\(names)")
        }
    }
}
