import Foundation
import Observation
import ShepherdKit
import Testing

@testable import Shepherd

/// The installer owns lifecycle wiring, including models rebuilt after a profile switch.
@MainActor
@Suite(.serialized)
struct HerdStreamTests {
    private func withApp(_ body: (AppModel) async throws -> Void) async throws {
        let suite = "HerdStreamTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
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

    @Test func installingIntoAnActiveStoreWiresTheSidebarAndMergedSeam() async throws {
        try await withApp { app in
            try await activate(app, name: "active")
            SessionSignals.connect(app)
            HerdStream.install(app)
            let sidebar = try #require(app.extension(SidebarModel.self))
            let herd = try seed(app)
            let session = PreviewData.session(id: "a", status: .init(known: .idle))
            #expect(sidebar.gitStage(session) == .ciFailed)
            #expect(!sidebar.inReview(session))
            herd.applyForTesting(name: "session:reviewing", payload: ["id": "a", "reviewing": true])
            #expect(sidebar.inReview(session))
            #expect(sidebar.gitStage(session) == .reviewerRunning)
            _ = try seed(app, state: "merged", checks: "success")
            #expect(SessionSignals.gitMerged("a"))
            #expect(!SessionSignals.gitMerged("missing"))
            app.teardown()
            #expect(!SessionSignals.gitMerged("a"))
            #expect(sidebar.gitStage(session) == nil)
            #expect(!sidebar.inReview(session))
        }
    }

    @Test func installingBeforeActivationWiresEveryNewInstance() async throws {
        try await withApp { app in
            SessionSignals.connect(app)
            HerdStream.install(app)
            let merged = SessionSignals.gitMerged
            #expect(!merged("a"))
            #expect(app.extension(HerdSignals.self) == nil)
            try await activate(app, name: "first")
            let firstSidebar = try #require(app.extension(SidebarModel.self))
            let firstHerd = try seed(app, state: "merged", checks: "success")
            let firstNotifications = try #require(app.extension(NotificationsModel.self))
            let session = PreviewData.session(id: "a", status: .init(known: .idle))
            #expect(firstSidebar.gitStage(session) == .merged)
            #expect(merged("a"))

            try await activate(app, name: "second")
            let secondSidebar = try #require(app.extension(SidebarModel.self))
            let secondHerd = try seed(app)
            let secondNotifications = try #require(app.extension(NotificationsModel.self))
            #expect(secondHerd !== firstHerd)
            #expect(secondSidebar !== firstSidebar)
            #expect(secondSidebar.gitStage(session) == .ciFailed)
            #expect(firstSidebar.gitStage(session) == .ciFailed, "retained closures resolve the current activation")
            #expect(!merged("a"))
            secondHerd.applyForTesting(name: "session:reviewing", payload: ["id": "a", "reviewing": true])
            #expect(secondSidebar.inReview(session))
            #expect(firstSidebar.inReview(session))
            #expect(await herdSettle(until: { secondNotifications.extraAttention == ["a"] }))
            #expect(firstNotifications.extraAttention.isEmpty)
        }
    }

    @Test func repeatedInstallKeepsTheLiveInstancesAndSubscriptions() async throws {
        try await withApp { app in
            HerdStream.install(app)
            try await activate(app, name: "twice")
            let herd = try seed(app)
            let sidebar = try #require(app.extension(SidebarModel.self))
            let keys = app.extensionFactories.map(\.key)
            let instances = app.liveExtensions.map { ObjectIdentifier($0.value) }
            HerdStream.install(app)
            #expect(app.extensionFactories.map(\.key) == keys)
            #expect(app.liveExtensions.map { ObjectIdentifier($0.value) } == instances)
            #expect(app.extension(HerdSignals.self) === herd)
            #expect(herd.isSubscribed)
            #expect(sidebar.gitStage(PreviewData.session(id: "a", status: .init(known: .idle))) == .ciFailed)
        }
    }

    @Test func ciRedFeedsNotificationsAndClearsOnRecovery() async throws {
        try await withApp { app in
            HerdStream.install(app)
            try await activate(app, name: "ci")
            let herd = try seed(app)
            let notifications = try #require(app.extension(NotificationsModel.self))
            #expect(await herdSettle(until: { notifications.extraAttention == ["a"] }))
            _ = try seed(app, checks: "success")
            #expect(await herdSettle(until: { notifications.extraAttention.isEmpty }))
            // A queued observation from the old activation must never write after teardown.
            herd.applyForTesting(name: "session:git", payload: [
                "id": "late", "git": ["state": "open", "checks": "failure", "deployConfigured": false],
            ])
            app.teardown()
            for _ in 0..<20 { await Task.yield() }
            #expect(notifications.extraAttention.isEmpty)
        }
    }

    @Test func fullAndGitOnlyCandidatesGiveTheSamePartition() async throws {
        try await withApp { app in
            HerdStream.install(app)
            try await activate(app, name: "partition")
            let herd = try seed(app)
            let sidebar = try #require(app.extension(SidebarModel.self))
            for status in [SessionStatus.Known.idle, .running] {
                var session = PreviewData.session(id: "a", status: .init(known: status))
                for ready in [false, true] {
                    session.readyToMerge = ready
                    for reviewing in [false, true] {
                        herd.applyForTesting(name: "session:reviewing", payload: ["id": "a", "reviewing": reviewing])
                        let full = HerdPartition.stageOf(session, now: 0,
                            gitStage: sidebar.gitStage, inReview: sidebar.inReview)
                        let gitOnly = HerdPartition.stageOf(session, now: 0, gitStage: { session in
                            let stage = herd.stage(for: session)
                            return [.active, .merging, .ready, .reviewerRunning].contains(stage) ? nil : stage
                        }, inReview: sidebar.inReview)
                        #expect(full == gitOnly)
                        #expect(full == herd.stage(for: session))
                    }
                }
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

    @Test func aVerdictEndsTheInFlightRun() async {
        let model = HerdSignals(reads: .stub(), now: { 0 })
        model.applyForTesting(name: "session:reviewing", payload: ["id": "a", "reviewing": true])
        #expect(model.isReviewing("a"))
        model.applyForTesting(name: "session:review", payload: ["id": "a", "review": verdictJSON])
        #expect(model.verdicts["a"]?.headSha == "abc")
        #expect(!model.isReviewing("a"))
    }

    @Test func aNullReviewDeletesTheVerdict() async throws {
        let model = HerdSignals(reads: .stub(verdicts: ["a": try verdict]), now: { 0 })
        await model.refresh()
        model.applyForTesting(name: "session:reviewing", payload: ["id": "a", "reviewing": true])
        model.applyForTesting(name: "session:review", payload: ["id": "a", "review": NSNull()])
        #expect(model.verdicts["a"] == nil)
        #expect(!model.isReviewing("a"))
    }

    @Test func bothEdgesOfReviewingClearTheActivityFeed() {
        let model = HerdSignals(reads: .stub(), now: { 0 })
        model.applyForTesting(name: "session:critic-activity", payload: ["id": "a", "summary": "old run"])
        model.applyForTesting(name: "session:reviewing", payload: ["id": "a", "reviewing": true])
        #expect(model.criticActivity["a"] == nil)
        model.applyForTesting(name: "session:critic-activity", payload: ["id": "a", "summary": "reading"])
        #expect(model.criticActivity["a"]?.count == 1)
        model.applyForTesting(name: "session:reviewing", payload: ["id": "a", "reviewing": false])
        #expect(model.criticActivity["a"] == nil)
    }

    @Test func theActivityFeedIsBoundedToTwoLines() {
        let model = HerdSignals(reads: .stub(), now: { 0 })
        for summary in ["one", "two", "two", "three", "three"] {
            model.applyForTesting(name: "session:critic-activity", payload: ["id": "a", "summary": summary])
        }
        #expect(model.criticActivity["a"] == ["two", "three"])
    }

    @Test func aRedundantReviewingTrueStillRefreshesTheEnv() {
        let model = HerdSignals(reads: .stub(), now: { 0 })
        for provider in ["claude", "codex"] {
            model.applyForTesting(name: "session:reviewing", payload: [
                "id": "a", "reviewing": true,
                "env": ["provider": provider, "model": "model", "effort": "high"],
            ])
            if provider == "claude" {
                model.applyForTesting(name: "session:critic-activity", payload: ["id": "a", "summary": "reading"])
            }
        }
        #expect(model.reviewerEnv["a"]?.provider?.known == .codex)
        #expect(model.criticActivity["a"] == ["reading"])
        model.applyForTesting(name: "session:reviewing", payload: ["id": "a", "reviewing": false])
        #expect(model.reviewerEnv["a"] == nil)
    }

    @Test func refreshInstallsAllFiveSnapshotsAndClearsOldActivity() async throws {
        let model = HerdSignals(reads: .stub(git: ["a": redGit],
            activity: ["a": .init(lastActivityTs: 10, summary: "working", recentTs: [10], recentErrTs: [])],
            claudeAlive: ["a": false], verdicts: ["a": try verdict],
            reviewing: [.init(id: "a", provider: .init(known: .codex), model: "gpt", effort: "high")]), now: { 0 })
        model.applyForTesting(name: "session:critic-activity", payload: ["id": "a", "summary": "old"])
        await model.refresh()
        #expect(model.git["a"]?.checks.known == .failure)
        #expect(model.activity["a"]?.summary == "working")
        #expect(model.claudeAlive["a"] == false)
        #expect(model.verdicts["a"]?.headSha == "abc")
        #expect(model.isReviewing("a"))
        #expect(model.reviewerEnv["a"]?.model == "gpt")
        #expect(model.criticActivity.isEmpty)
        #expect(model.ciRed == ["a"], "a dirty PR must not mask red CI")
        #expect(model.stage(for: PreviewData.session(id: "a", status: .init(known: .idle))) == .reviewerRunning)
        model.reads = .stub()
        await model.refresh()
        #expect(model.reviewing.isEmpty)
        #expect(model.reviewerEnv.isEmpty)
        #expect(model.git.isEmpty)
    }

    @Test func aRefreshThatLostItsRaceIsDropped() async {
        let gate = HerdReadGate()
        var reads = HerdReads.stub()
        reads.claudeAlive = { await gate.wait(); return ["old": true] }
        let model = HerdSignals(reads: reads, now: { 0 })
        let old = Task { await model.refresh() }
        #expect(await herdSettle(until: { await gate.entered }))
        model.reads = .stub(claudeAlive: ["new": true])
        await model.refresh()
        await gate.open()
        await old.value
        #expect(model.claudeAlive == ["new": true])
    }

    @Test func aFailedReadRetainsTheWholePreviousSnapshot() async {
        struct Failed: Error {}
        let model = HerdSignals(reads: .stub(claudeAlive: ["old": true]), now: { 0 })
        await model.refresh()
        model.reads = .stub(claudeAlive: ["new": true])
        model.reads.git = { throw Failed() }
        await model.refresh()
        #expect(model.claudeAlive == ["old": true])
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

    @Test func everyReconnectReReadsAllFiveSnapshots() async {
        let ledger = HerdReadLedger()
        let model = HerdSignals(reads: counting(ledger), now: { 0 })
        defer { model.teardown() }
        let box = ConnectionBox()
        model.watchConnection { box.read() }
        #expect(await herdSettle(until: { box.reads >= 2 }))
        for count in 1...2 {
            box.state = .live
            #expect(await herdSettle(until: { await ledger.counts.values.reduce(0, +) == count * 5 }))
            let previousReads = box.reads
            box.state = .connecting
            #expect(await herdSettle(until: { box.reads > previousReads }))
        }
        #expect(await ledger.counts == ["git": 2, "activity": 2, "alive": 2, "verdicts": 2, "reviewing": 2])
    }

    @Test func teardownEndsTheConnectionWatcherLoop() async {
        let model = HerdSignals(reads: .stub(), now: { 0 })
        let box = ConnectionBox()
        model.watchConnection { box.read() }
        #expect(await herdSettle(until: { box.reads >= 2 }))
        #expect(model.isWatchingConnection)
        model.teardown()
        #expect(await herdSettle(until: { !model.isWatchingConnection }))
    }

    @Test func replacingTheConnectionWatcherKeepsTheNewLoopAlive() async {
        let model = HerdSignals(reads: .stub(), now: { 0 })
        let box = ConnectionBox()
        model.watchConnection { box.read() }
        model.watchConnection { box.read() }
        #expect(await herdSettle(until: { box.reads >= 2 }))
        #expect(model.isWatchingConnection)
        model.teardown()
        #expect(await herdSettle(until: { !model.isWatchingConnection }))
    }

    @Test func teardownDropsAnInFlightRefresh() async {
        let gate = HerdReadGate()
        var reads = HerdReads.stub()
        reads.claudeAlive = { await gate.wait(); return ["late": true] }
        let model = HerdSignals(reads: reads, now: { 0 })
        let refresh = Task { await model.refresh() }
        #expect(await herdSettle(until: { await gate.entered }))
        model.teardown()
        await gate.open()
        await refresh.value
        #expect(model.claudeAlive.isEmpty)
        await model.refresh()
        #expect(model.claudeAlive.isEmpty)
    }

    private func withLiveModel(
        _ body: (HerdSignals, SessionStore, AppModel) async throws -> Void
    ) async throws {
        let suite = "HerdSignalsTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
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

    @Test func theTapAppliesAllSixFramesWithoutReReading() async throws {
        try await withLiveModel { model, store, _ in
            let ledger = HerdReadLedger()
            model.reads = counting(ledger)
            #expect(await herdSettle(until: { await ledger.counts.values.reduce(0, +) == 5 }))
            // Finish the bootstrap before measuring frame-only reads.
            await model.refresh()
            let before = await ledger.counts
            store.apply(try event("session:git", ["id": "a", "git": ["state": "open", "checks": "failure", "deployConfigured": false]]))
            store.apply(try event("session:activity", ["id": "a", "activity": ["lastActivityTs": 10, "summary": "coding", "recentTs": [10], "recentErrTs": []]]))
            store.apply(try event("session:claude-alive", ["id": "a", "claudeAlive": false, "liveness": "stranded"]))
            store.apply(try event("session:reviewing", ["id": "a", "reviewing": true]))
            store.apply(try event("session:critic-activity", ["id": "a", "summary": "reading"]))
            #expect(await herdSettle(until: { model.criticActivity["a"] == ["reading"] }))
            #expect(model.isReviewing("a"))
            store.apply(try event("session:review", ["id": "a", "review": verdictJSON]))
            #expect(await herdSettle(until: { model.verdicts["a"] != nil }))
            #expect(!model.isReviewing("a"))
            #expect(model.git["a"]?.checks.known == .failure)
            #expect(model.activity["a"]?.summary == "coding")
            #expect(model.claudeAlive["a"] == false)
            #expect(await ledger.counts == before)
        }
    }

    @Test func activationChangesDropBothSnapshotsAndBufferedFrames() async throws {
        try await withLiveModel { model, store, app in
            model.reads = .stub(claudeAlive: ["seed": true])
            #expect(await herdSettle(until: { model.claudeAlive == ["seed": true] }))
            let gate = HerdReadGate()
            model.reads.claudeAlive = { await gate.wait(); return ["late": true] }
            let refresh = Task { await model.refresh() }
            #expect(await herdSettle(until: { await gate.entered }))
            store.apply(try event("session:claude-alive", ["id": "late", "claudeAlive": true, "liveness": "alive"]))
            app.teardown()
            await gate.open()
            await refresh.value
            #expect(model.claudeAlive == ["seed": true])
            // New work requested on this obsolete instance also belongs to the old activation.
            await model.refresh()
            #expect(model.claudeAlive == ["seed": true])
        }
    }

    @Test func teardownRejectsBufferedFrames() async throws {
        try await withLiveModel { model, store, _ in
            store.apply(try event("session:claude-alive", ["id": "late", "claudeAlive": true, "liveness": "alive"]))
            model.teardown()
            #expect(await herdSettle(until: { !model.isWatchingConnection }))
            #expect(model.claudeAlive.isEmpty)
        }
    }

    @Test func reconnectBurstsCollapseToOneFollowUpRead() async {
        let gate = HerdReadGate()
        let ledger = HerdReadLedger()
        var reads = counting(ledger)
        reads.claudeAlive = { await ledger.bump("alive"); await gate.wait(); return [:] }
        let model = HerdSignals(reads: reads, now: { 0 })
        defer { model.teardown() }
        let box = ConnectionBox()
        model.watchConnection { box.read() }
        #expect(await herdSettle(until: { box.reads >= 2 }))
        box.state = .live
        #expect(await herdSettle(until: { await gate.entered }))
        for _ in 0..<5 {
            var before = box.reads
            box.state = .connecting
            #expect(await herdSettle(until: { box.reads > before }))
            before = box.reads
            box.state = .live
            #expect(await herdSettle(until: { box.reads > before }))
        }
        #expect(await ledger.counts["alive"] == 1)
        await gate.open()
        #expect(await herdSettle(until: { await ledger.counts.values.reduce(0, +) == 10 }))
        #expect(await ledger.counts == ["git": 2, "activity": 2, "alive": 2, "verdicts": 2, "reviewing": 2])
    }

    @Test func aFrameRacingABootstrapAppliesImmediatelyAndReconcilesOnce() async {
        let oldGate = HerdReadGate()
        var reads = HerdReads.stub()
        reads.claudeAlive = { await oldGate.wait(); return ["a": false] }
        let model = HerdSignals(reads: reads, now: { 0 })
        defer { model.teardown() }
        let old = Task { await model.refresh() }
        #expect(await herdSettle(until: { await oldGate.entered }))
        let ledger = HerdReadLedger()
        reads = counting(ledger)
        reads.claudeAlive = { await ledger.bump("alive"); return ["a": true, "b": true] }
        model.reads = reads
        for _ in 0..<8 {
            model.applyForTesting(name: "session:claude-alive", payload: ["id": "a", "claudeAlive": true, "liveness": "alive"])
        }
        #expect(model.claudeAlive["a"] == true)
        await oldGate.open()
        await old.value
        #expect(await herdSettle(until: { model.claudeAlive["b"] == true }))
        #expect(model.claudeAlive["a"] == true)
        // One reconciliation plus at most one pending retry, independent of burst size.
        #expect(await ledger.counts["alive", default: 0] <= 2)
    }

    @Test func malformedAndUnrelatedFramesLeaveStateAlone() {
        let model = HerdSignals(reads: .stub(), now: { 0 })
        model.applyForTesting(name: "session:reviewing", payload: ["id": "a", "reviewing": true])
        model.applyForTesting(name: "session:review", payload: ["id": "a", "review": "invalid"])
        model.applyForTesting(name: "session:git", payload: ["id": "a"])
        model.applyForTesting(name: "future:event", payload: [:])
        #expect(model.isReviewing("a"))
        #expect(model.git.isEmpty)
    }
}
