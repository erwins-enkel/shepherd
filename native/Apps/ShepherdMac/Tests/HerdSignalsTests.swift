import Foundation
import Observation
import ShepherdKit
import Testing

@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
/// The installer owns lifecycle wiring, including models rebuilt after a profile switch.
@MainActor
@Suite(.serialized)
struct HerdStreamTests {
    private func withApp(_ body: (AppModel) async throws -> Void) async throws {
        let suite = "HerdStreamTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
        app.health = { _ in throw CancellationError() }
        defer {
            app.teardown()
            defaults.removePersistentDomain(forName: suite)
        }
        app.register(SidebarModel.self)
        app.register(NotificationsModel.self)
        try await body(app)
    }

    private func activate(_ app: AppModel, name: String) async throws {
        let profile = try app.addRemoteProfile(name: name, address: "https://\(name).invalid")
        await app.activate(profile)
        // No credentials or live endpoint: the real lifecycle builds a store, with fake reads.
        app.extension(SidebarModel.self)?.reads = SidebarReads(
            workingBlocked: { [:] }, holds: { [:] }, blocks: { [:] },
            usage: { throw CancellationError() })
    }

    private func seed(_ app: AppModel, state: String = "open", checks: String = "failure") throws -> HerdSignals {
        let herd = try #require(app.extension(HerdSignals.self))
        let payload: [String: Any] = ["state": state, "checks": checks, "deployConfigured": false]
        let git = try JSONDecoder().decode(GitState.self,
            from: JSONSerialization.data(withJSONObject: payload))
        herd.reads = .stub(git: ["a": git])
        herd.applyForTesting(name: "session:git", payload: ["id": "a", "git": payload])
        return herd
    }

    @Test func planReviewWithoutCriticReviewLeavesTheReadyLens() async throws {
        try await withApp { app in
            HerdStream.install(app)
            try await activate(app, name: "plan-review")
            let herd = try seed(app, state: "none", checks: "none")
            let sidebar = try #require(app.extension(SidebarModel.self))
            let session = PreviewData.session(id: "a", status: .init(known: .idle))
            @MainActor func ready() -> [Session] {
                HerdPartition.shown([session], lens: .ready, workingBlocked: [:], now: 0,
                    gitStage: sidebar.gitStage, inReview: sidebar.inReview)
            }
            #expect(ready().map(\.id) == ["a"])
            #expect(!herd.isReviewing(session.id))
            herd.planReviewing = { _ in true }
            #expect(herd.stage(for: session) == .reviewerRunning)
            #expect(sidebar.inReview(session))
            #expect(ready().isEmpty)
            var paused = session
            paused.autopilotPaused = true
            @MainActor func row() -> HerdRowSignals.Presentation {
                HerdRowSignals.presentation(for: paused, herd: herd, block: nil, showCli: false, now: 0)
            }
            // Plan review still excludes Ready, but cannot invent a PR review or hide autopilot.
            #expect(row().stepper.reached == .implementing)
            #expect(row().stepper.review == .none)
            #expect(!row().badges.contains { $0.id == "critic" })
            #expect(row().badges.contains { $0.id == "needs-you" })
            herd.applyForTesting(name: "session:reviewing", payload: ["id": "a", "reviewing": true])
            #expect(row().stepper.reached == .review)
            #expect(row().stepper.review == .reviewing)
            #expect(row().badges.first { $0.id == "critic" }?.text == L.t("criticbadge_reviewing"))
            #expect(!row().badges.contains { $0.id == "needs-you" })
            herd.applyForTesting(name: "session:reviewing", payload: ["id": "a", "reviewing": false])
            herd.planReviewing = { _ in false }
            #expect(ready().map(\.id) == ["a"])
        }
    }

}
}

private actor HerdReadLedger {
    private(set) var counts: [String: Int] = [:]
    func bump(_ key: String) { counts[key, default: 0] += 1 }
}

private actor HerdReadGate {
    private let stream: AsyncStream<Void>
    private let signal: AsyncStream<Void>.Continuation
    private(set) var entered = false
    init() { (stream, signal) = AsyncStream.makeStream() }
    func wait() async {
        entered = true
        for await _ in stream {}
    }
    func open() { signal.finish() }
}

@MainActor
private func herdSettle(until condition: () async -> Bool, yields: Int = 1_000) async -> Bool {
    for _ in 0..<yields {
        if await condition() { return true }
        await Task.yield()
    }
    return await condition()
}

@MainActor
struct HerdSignalsTests {
    private let verdictJSON: [String: Any] = [
        "sessionId": "a", "headSha": "abc", "decision": "changes_requested",
        "summary": "fix", "body": "fix it", "findings": ["edge case"],
        "addressRound": 1, "addressCap": 3, "finalRoundPending": false,
        "finalRoundTimeoutMs": 900_000, "updatedAt": 0,
    ]
    private var verdict: ReviewVerdict {
        get throws {
            try JSONDecoder().decode(ReviewVerdict.self,
                from: JSONSerialization.data(withJSONObject: verdictJSON))
        }
    }
    private var redGit: GitState {
        GitState(state: .init(known: .open), checks: .init(known: .failure),
            mergeStateStatus: .init(known: .dirty), deployConfigured: false)
    }

    @Observable @MainActor
    final class ConnectionBox {
        var state: ConnectionState = .idle
        @ObservationIgnored var reads = 0
        func read() -> ConnectionState { reads += 1; return state }
    }

    private func counting(_ ledger: HerdReadLedger) -> HerdReads {
        HerdReads(
            git: { await ledger.bump("git"); return [:] },
            activity: { await ledger.bump("activity"); return [:] },
            claudeAlive: { await ledger.bump("alive"); return [:] },
            verdicts: { await ledger.bump("verdicts"); return [:] },
            reviewing: { await ledger.bump("reviewing"); return [] })
    }

    private func withLiveModel(
        _ body: (HerdSignals, SessionStore, AppModel) async throws -> Void
    ) async throws {
        let suite = "HerdSignalsTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
        let profile = ServerProfile(name: "herd test", baseURL: URL(string: "https://herd.invalid")!, mode: .remote)
        let store = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
        let model = HerdSignals(store: store, app: app)
        model.reads = .stub()
        defer {
            model.teardown()
            app.teardown()
            store.stop()
            defaults.removePersistentDomain(forName: suite)
        }
        try await body(model, store, app)
    }

    private func event(_ name: String, _ payload: [String: Any]) throws -> ServerEvent {
        .unknown(name: name, payload: try JSONSerialization.data(withJSONObject: payload))
    }

}
