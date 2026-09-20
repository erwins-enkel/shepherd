import Foundation
import Observation
import ShepherdKit
import Testing
@testable import Shepherd

private actor QueueReadGate {
    private(set) var calls = 0
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func enter() async {
        calls += 1
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        opened = true
        for waiter in waiters { waiter.resume() }
        waiters.removeAll()
    }
}

@MainActor @Observable
private final class QueueConnectionBox {
    var state: ConnectionState = .idle
}

@MainActor
private func queueSettle(_ condition: () async -> Bool) async -> Bool {
    for _ in 0..<1_000 {
        if await condition() { return true }
        await Task.yield()
    }
    return await condition()
}

@MainActor
private final class QueueFixture {
    let suite = "QueuesModelTests.\(UUID().uuidString)"
    let defaults: UserDefaults
    let app: AppModel
    let store: SessionStore
    let model: QueuesModel

    init(_ reads: QueuesReads) throws {
        defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        store = try SessionStore(
            profile: ServerProfile(name: "queues", baseURL: URL(string: "https://queues.invalid")!,
                                   mode: .remote),
            credentials: InMemoryCredentialStore())
        model = QueuesModel(store: store, app: app)
        // No suspension before replacing the live closures; no test starts the store/socket.
        model.reads = reads
    }

    func close() {
        model.teardown()
        store.stop()
        app.teardown()
        defaults.removePersistentDomain(forName: suite)
    }
}

@MainActor
struct QueuesModelTests {
    private var empty: QueuesReads {
        QueuesReads(held: { [] }, done: { [] }, recaps: { [:] }, stranded: { [] },
                    refreshUpNext: {})
    }

    private func held(_ id: String) throws -> HeldQueueEntry {
        try JSONDecoder().decode(HeldQueueEntry.self, from: Data("""
            {"id":"\(id)","repoPath":"/repo",
             "input":{"repoPath":"/repo","baseBranch":"main","prompt":"task"},
             "createdAt":1,"reason":"capacity"}
            """.utf8))
    }

    private func frame(_ name: String, _ json: String) throws -> ServerEvent {
        try JSONDecoder().decode(ServerEvent.self,
            from: Data("{\"event\":\"\(name)\",\"data\":\(json)}".utf8))
    }

    private func snapshot(_ time: Int, populated: Bool = false) throws -> ServerEvent {
        let sections = populated ? """
            [{"kind":"repo","repoPath":"/repo","repoSlug":null,"repoLabel":"Old",
              "items":[],"totalCount":0}]
            """ : "[]"
        return try frame("upnext:snapshot", """
            {"snapshot":{"generatedAt":\(time),"sections":\(sections),"repoCount":\(time),
             "fallback":null,"failedRepoCount":0}}
            """)
    }

    @Test func bootstrapLoadsEverySnapshotAndSubscribes() async throws {
        let row = try held("held")
        let session = PreviewData.session(id: "done")
        let recap = Recap(sessionId: "done", state: .init(known: .ready),
                          headline: "Done", body: "Shipped", openItems: [], updatedAt: 1)
        let computed = QueueReadGate()
        await computed.open()
        var reads = empty
        reads.held = { [row] }
        reads.done = { [session] }
        reads.recaps = { ["done": recap] }
        reads.stranded = { ["stranded"] }
        reads.refreshUpNext = { await computed.enter() }
        let f = try QueueFixture(reads)
        defer { f.close() }
        #expect(f.model.isSubscribed)
        #expect(await queueSettle { !f.model.isRefreshing })
        #expect(f.model.held == [row] && f.model.heldCount == 1)
        #expect(f.model.done == [session] && f.model.recaps == ["done": recap])
        #expect(f.model.stranded == ["stranded"])
        #expect(await computed.calls == 1)
        #expect(f.model.upNext == nil && !f.model.upNextLoadFailed)
    }

    @Test func heldCountArrivesImmediatelyThenRereadsTheList() async throws {
        let f = try QueueFixture(empty)
        defer { f.close() }
        #expect(await queueSettle { !f.model.isRefreshing })
        let gate = QueueReadGate()
        let row = try held("fresh")
        f.model.reads.held = { await gate.enter(); return [row] }
        f.store.apply(try frame("held:changed", "{\"count\":7}"))
        #expect(await queueSettle { f.model.heldCount == 7 })
        #expect(f.model.held.isEmpty)
        await gate.open()
        #expect(await queueSettle { !f.model.isRefreshing })
        #expect(f.model.held == [row] && f.model.heldCount == 1)
    }

    @Test func reconnectRereadsHeldAndRequestsUpNextEvenWithoutAFrame() async throws {
        let f = try QueueFixture(empty)
        defer { f.close() }
        #expect(await queueSettle { !f.model.isRefreshing })
        let box = QueueConnectionBox()
        let calls = QueueReadGate()
        await calls.open()
        let row = try held("reconnected")
        f.model.reads.held = { [row] }
        f.model.reads.refreshUpNext = { await calls.enter() }
        f.model.watchConnection { box.state }
        // Let the observation arm while idle.
        for _ in 0..<30 { await Task.yield() }
        box.state = .live
        #expect(await queueSettle { f.model.held == [row] })
        box.state = .idle
        for _ in 0..<30 { await Task.yield() }
        box.state = .live
        #expect(await queueSettle { await calls.calls == 2 })
        #expect(await queueSettle { !f.model.isRefreshing })
    }

    @Test func upNextSnapshotReplacesWholesaleAndClearsFailure() async throws {
        var reads = empty
        reads.refreshUpNext = { throw ShepherdError.unauthenticated }
        let f = try QueueFixture(reads)
        defer { f.close() }
        #expect(await queueSettle { f.model.upNextLoadFailed })
        f.store.apply(try snapshot(1, populated: true))
        #expect(await queueSettle { f.model.upNext?.generatedAt == 1 })
        #expect(f.model.upNext?.sections.first?.repoLabel == "Old")
        #expect(!f.model.upNextLoadFailed)
        f.store.apply(try snapshot(2))
        #expect(await queueSettle { f.model.upNext?.generatedAt == 2 })
        #expect(f.model.upNext?.repoCount == 2)
        #expect(f.model.upNext?.sections.isEmpty == true)
    }

    @Test(arguments: [false, true])
    func archiveAndOrdinaryRecoveryInvalidateLateStrandedReads(recovery: Bool) async throws {
        var reads = empty
        reads.stranded = { ["s1"] }
        let f = try QueueFixture(reads)
        defer { f.close() }
        f.store.apply(.sessionNew(PreviewData.session(id: "s1")))
        #expect(await queueSettle { !f.model.isRefreshing })
        #expect(f.model.stranded == ["s1"])
        let old = QueueReadGate()
        let fresh = QueueReadGate()
        f.model.reads.stranded = { await old.enter(); return ["s1"] }
        let pending = Task { await f.model.refresh(recomputeUpNext: false) }
        #expect(await queueSettle { await old.calls == 1 })
        f.model.reads.stranded = { await fresh.enter(); return [] }
        f.store.apply(try frame(recovery ? "session:claude-alive" : "session:archived",
            recovery ? "{\"id\":\"s1\",\"claudeAlive\":true,\"liveness\":\"alive\"}" : "{\"id\":\"s1\"}"))
        #expect(await queueSettle { await fresh.calls == 1 })
        await fresh.open()
        #expect(await queueSettle { f.model.stranded.isEmpty })
        await old.open()
        await pending.value
        #expect(f.model.stranded.isEmpty)
    }

    @Test func archiveFencesTheSnapshotBeforeItsQueuedFollowUpCompletes() async throws {
        let old = QueueReadGate()
        let fresh = QueueReadGate()
        var reads = empty
        reads.stranded = { ["s1"] }
        let f = try QueueFixture(reads)
        defer { f.close() }
        #expect(await queueSettle { !f.model.isRefreshing })
        f.model.reads.stranded = { await old.enter(); return ["s1"] }
        f.store.apply(try frame("app:sessions-stranded", "{\"count\":1}"))
        #expect(await queueSettle { await old.calls == 1 })
        f.model.reads.stranded = { await fresh.enter(); return [] }
        f.store.apply(try frame("session:archived", "{\"id\":\"s1\"}"))
        #expect(await queueSettle { f.model.stranded.isEmpty })
        await old.open()
        #expect(await queueSettle { await fresh.calls == 1 })
        #expect(f.model.stranded.isEmpty)
        await fresh.open()
        #expect(await queueSettle { !f.model.isRefreshing })
        #expect(f.model.stranded.isEmpty)
    }

    @Test func archiveOfOnlySessionRejectsStaleFollowUpAndKeepsEmptyListAuthoritative() async throws {
        var reads = empty
        reads.stranded = { ["s1"] }
        let f = try QueueFixture(reads)
        defer { f.close() }
        f.store.apply(.sessionNew(PreviewData.session(id: "s1")))
        #expect(await queueSettle { !f.model.isRefreshing })
        #expect(f.model.stranded == ["s1"])
        #expect(f.store.sessions.map(\.id) == ["s1"])

        let stale = QueueReadGate()
        f.model.reads.stranded = { await stale.enter(); return ["s1"] }
        f.store.apply(try frame("session:archived", "{\"id\":\"s1\"}"))
        #expect(await queueSettle { await stale.calls == 1 })
        #expect(f.store.sessions.isEmpty && f.model.stranded.isEmpty)
        await stale.open()
        #expect(await queueSettle { !f.model.isRefreshing })
        #expect(f.model.stranded.isEmpty)

        // A different stale ID also cannot survive an authoritative empty session list.
        f.model.reads.stranded = { ["missing"] }
        await f.model.refresh(recomputeUpNext: false)
        #expect(f.model.stranded.isEmpty)
    }

    @Test(arguments: [false, true])
    func archivedIDRemainsTombstonedUntilServerConfirmsAbsence(reload: Bool) async throws {
        var reads = empty
        reads.stranded = { ["s1"] }
        let f = try QueueFixture(reads)
        defer { f.close() }
        f.store.apply(.sessionNew(PreviewData.session(id: "s1")))
        #expect(await queueSettle { !f.model.isRefreshing })
        #expect(f.model.stranded == ["s1"])
        let stale = QueueReadGate()
        f.model.reads.stranded = { await stale.enter(); return ["s1"] }
        f.store.apply(try frame("session:archived", "{\"id\":\"s1\"}"))
        #expect(await queueSettle { await stale.calls == 1 })
        // Even a restored session must not inherit its old stranded state.
        f.store.apply(.sessionNew(PreviewData.session(id: "s1")))
        await stale.open()
        #expect(await queueSettle { !f.model.isRefreshing })
        #expect(f.model.stranded.isEmpty)

        f.model.reads.stranded = { ["s1"] }
        if reload { try await f.model.reloadStranded() }
        else { await f.model.refresh(recomputeUpNext: false) }
        #expect(f.model.stranded.isEmpty)
        f.model.reads.stranded = { [] }
        if reload { try await f.model.reloadStranded() }
        else { await f.model.refresh(recomputeUpNext: false) }
        // Server cleanup releases the tombstone; a new stranded occurrence is valid.
        f.model.reads.stranded = { ["s1"] }
        await f.model.refresh(recomputeUpNext: false)
        #expect(f.model.stranded == ["s1"])
    }

    @Test func loadedSessionsPruneStrandedWithoutRemovingTaskOrIssueQueues() async throws {
        var reads = empty
        let row = try held("task-not-a-session")
        reads.held = { [row] }
        reads.stranded = { ["live", "archived"] }
        let f = try QueueFixture(reads)
        defer { f.close() }
        #expect(await queueSettle { !f.model.isRefreshing })
        // Empty means not bootstrapped: preserve until the store has a live list.
        #expect(f.model.stranded == ["live", "archived"])
        f.store.apply(.sessionNew(PreviewData.session(id: "live")))
        #expect(await queueSettle { f.model.stranded == ["live"] })
        await f.model.refresh(recomputeUpNext: false)
        #expect(f.model.stranded == ["live"])
        #expect(f.model.held == [row])
    }

    @Test func archiveRemovesImmediatelyEvenIfStrandedRereadFails() async throws {
        var reads = empty
        reads.stranded = { ["s1"] }
        let f = try QueueFixture(reads)
        defer { f.close() }
        #expect(await queueSettle { !f.model.isRefreshing })
        f.model.reads.stranded = { throw ShepherdError.unauthenticated }
        f.store.apply(try frame("session:archived", "{\"id\":\"s1\"}"))
        #expect(await queueSettle { f.model.stranded.isEmpty })
    }

    @Test func haltOnlyInvalidatesRetryPreselection() async throws {
        let session = PreviewData.session(id: "s1")
        var reads = empty
        reads.done = { [session] }
        let f = try QueueFixture(reads)
        defer { f.close() }
        #expect(await queueSettle { !f.model.isRefreshing })
        f.store.apply(.sessionNew(session))
        let before = f.model.retrySelectionGeneration
        f.store.apply(try frame("session:halt",
            "{\"id\":\"s1\",\"haltReason\":\"operator\",\"haltedAt\":1}"))
        #expect(await queueSettle { f.model.retrySelectionGeneration == before + 1 })
        #expect(f.store.sessions == [session])
        #expect(f.model.done == [session])
        #expect(!f.model.isRefreshing)
    }

    @Test func strandedGrowthRereadsIDsAndAutoRevivedKeepsItsOwnNotice() async throws {
        var reads = empty
        reads.stranded = { ["old", "gone"] }
        let f = try QueueFixture(reads)
        defer { f.close() }
        #expect(await queueSettle { !f.model.isRefreshing })
        f.model.reads.stranded = { ["new"] }
        f.store.apply(try frame("app:sessions-stranded", "{\"count\":19}"))
        #expect(await queueSettle { f.model.stranded == ["new"] })
        #expect(f.model.strandedNotice?.count == 19)
        f.store.apply(try frame("app:auto-revived", "{\"revived\":2,\"failed\":1}"))
        #expect(await queueSettle { f.model.autoRevivedNotice?.revived == 2 })
        #expect(f.model.autoRevivedNotice?.failed == 1)
        #expect(f.model.strandedNotice?.count == 19)
    }

    @Test func burstDuringBootstrapCollapsesToOneFollowUpWithoutRecomputingUpNext() async throws {
        let gate = QueueReadGate()
        let computed = QueueReadGate()
        await computed.open()
        var reads = empty
        reads.held = { await gate.enter(); return [] }
        reads.refreshUpNext = { await computed.enter() }
        let f = try QueueFixture(reads)
        defer { f.close() }
        #expect(await queueSettle { await gate.calls == 1 })
        for count in 1...10 {
            f.store.apply(try frame("held:changed", "{\"count\":\(count)}"))
        }
        #expect(await queueSettle { f.model.heldCount == 10 })
        #expect(await gate.calls == 1)
        await gate.open()
        #expect(await queueSettle { !f.model.isRefreshing })
        #expect(await gate.calls == 2)
        #expect(await computed.calls == 1)
    }

    @Test func teardownDropsAlreadyBufferedFramesAndEndsTheWatcher() async throws {
        let f = try QueueFixture(empty)
        defer { f.close() }
        #expect(await queueSettle { !f.model.isRefreshing })
        #expect(f.model.isWatchingConnection)
        f.store.apply(try snapshot(99))
        f.store.apply(try frame("held:changed", "{\"count\":99}"))
        f.store.apply(try frame("session:halt",
            "{\"id\":\"s1\",\"haltReason\":null,\"haltedAt\":null}"))
        f.model.teardown()
        #expect(await queueSettle { !f.model.isWatchingConnection })
        #expect(!f.model.isSubscribed && !f.model.isRefreshing)
        #expect(f.model.upNext == nil && f.model.heldCount == 0)
        #expect(f.model.retrySelectionGeneration == 0)
    }

    @Test func teardownRejectsAReadThatIgnoresCancellation() async throws {
        let gate = QueueReadGate()
        let row = try held("late")
        var reads = empty
        reads.held = { await gate.enter(); return [row] }
        let model = QueuesModel(reads: reads)
        let read = Task { await model.refresh() }
        #expect(await queueSettle { await gate.calls == 1 })
        model.teardown()
        await gate.open()
        await read.value
        #expect(model.held.isEmpty && model.heldCount == 0)
    }

    @Test func activationChangeRejectsBothReadResultsAndBufferedEvents() async throws {
        let gate = QueueReadGate()
        let row = try held("old-server")
        var reads = empty
        reads.held = { await gate.enter(); return [row] }
        reads.refreshUpNext = { throw ShepherdError.unauthenticated }
        let f = try QueueFixture(reads)
        defer { f.close() }
        #expect(await queueSettle { await gate.calls == 1 })
        f.store.apply(try snapshot(99))
        f.app.teardown()
        await gate.open()
        #expect(await queueSettle { !f.model.isRefreshing })
        #expect(f.model.held.isEmpty && f.model.upNext == nil)
        #expect(!f.model.upNextLoadFailed)
    }

    @Test func newerRefreshWinsWithoutKillingTheEventTap() async throws {
        let f = try QueueFixture(empty)
        defer { f.close() }
        #expect(await queueSettle { !f.model.isRefreshing })
        let gate = QueueReadGate()
        let old = try held("old")
        let new = try held("new")
        f.model.reads.held = { await gate.enter(); return [old] }
        let olderRead = Task { await f.model.refresh() }
        #expect(await queueSettle { await gate.calls == 1 })
        f.model.reads.held = { [new] }
        await f.model.refresh()
        await gate.open()
        await olderRead.value
        #expect(f.model.held == [new])
        f.store.apply(try snapshot(3))
        #expect(await queueSettle { f.model.upNext?.generatedAt == 3 })
    }

    @Test func snapshotBeatsAnOlderUpNextRequestFailure() async throws {
        let gate = QueueReadGate()
        var reads = empty
        reads.refreshUpNext = { await gate.enter(); throw ShepherdError.unauthenticated }
        let f = try QueueFixture(reads)
        defer { f.close() }
        #expect(await queueSettle { await gate.calls == 1 })
        f.store.apply(try snapshot(1))
        #expect(await queueSettle { f.model.upNext != nil })
        await gate.open()
        #expect(await queueSettle { !f.model.isRefreshing })
        #expect(!f.model.upNextLoadFailed)
    }

    @Test func heldEventCountSurvivesAnOlderReadUntilTheFollowUpLands() async throws {
        let older = QueueReadGate()
        let followUp = QueueReadGate()
        var reads = empty
        reads.held = { await older.enter(); return [] }
        let f = try QueueFixture(reads)
        defer { f.close() }
        #expect(await queueSettle { await older.calls == 1 })
        let row = try held("latest")
        f.model.reads.held = { await followUp.enter(); return [row] }
        f.store.apply(try frame("held:changed", "{\"count\":7}"))
        #expect(await queueSettle { f.model.heldCount == 7 })
        await older.open()
        #expect(await queueSettle { await followUp.calls == 1 })
        #expect(f.model.heldCount == 7)
        await followUp.open()
        #expect(await queueSettle { !f.model.isRefreshing })
        #expect(f.model.heldCount == 1 && f.model.held == [row])
    }

    @Test func replacingConnectionWatcherKeepsTheReplacementAlive() async throws {
        let f = try QueueFixture(empty)
        defer { f.close() }
        #expect(await queueSettle { !f.model.isRefreshing })
        let old = QueueConnectionBox()
        let new = QueueConnectionBox()
        f.model.watchConnection { old.state }
        for _ in 0..<30 { await Task.yield() }
        f.model.watchConnection { new.state }
        for _ in 0..<30 { await Task.yield() }
        #expect(f.model.isWatchingConnection)
        let calls = QueueReadGate()
        await calls.open()
        f.model.reads.held = { await calls.enter(); return [] }
        old.state = .live
        for _ in 0..<30 { await Task.yield() }
        #expect(await calls.calls == 0)
        new.state = .live
        #expect(await queueSettle { await calls.calls == 1 })
        f.model.teardown()
        #expect(await queueSettle { !f.model.isWatchingConnection })
    }

    @Test func failedReadPreservesItsSnapshotWithoutDiscardingSuccessfulReads() async throws {
        let old = try held("old")
        let new = try held("new")
        var reads = empty
        reads.held = { [old] }
        reads.stranded = { ["keep"] }
        let model = QueuesModel(reads: reads)
        defer { model.teardown() }
        await model.refresh()
        model.reads.held = { [new] }
        model.reads.stranded = { throw ShepherdError.unauthenticated }
        model.reads.refreshUpNext = { throw ShepherdError.unauthenticated }
        await model.refresh()
        #expect(model.held == [new] && model.stranded == ["keep"])
        #expect(model.upNextLoadFailed)
    }

    @Test func malformedAndUnrelatedFramesDoNotChangeStateOrTriggerReads() async throws {
        let f = try QueueFixture(empty)
        defer { f.close() }
        #expect(await queueSettle { !f.model.isRefreshing })
        let calls = QueueReadGate()
        await calls.open()
        f.model.reads.held = { await calls.enter(); return [] }
        for name in ["held:changed", "upnext:snapshot", "session:halt",
                     "app:sessions-stranded", "app:auto-revived", "unrelated"] {
            f.store.apply(try frame(name, "{}"))
        }
        // A valid sentinel proves all preceding frames have been consumed.
        f.store.apply(try snapshot(1))
        #expect(await queueSettle { f.model.upNext != nil })
        #expect(await calls.calls == 0)
        #expect(f.model.heldCount == 0 && f.model.retrySelectionGeneration == 0)
        #expect(f.model.strandedNotice == nil && f.model.autoRevivedNotice == nil)
    }
}

@MainActor
struct QueueActionsTests {
    private var commands: QueueActionCommands {
        .init(halt: { .init(halted: 2) }, retry: { _, _ in .init(resumed: 1, steered: 2, total: 3) },
              revive: { .init(revived: 2, failed: 1) }, restore: { PreviewData.session(id: $0) },
              broadcast: { _, _ in .init(delivered: 1, queued: 2, offline: 3, skipped: 4, total: 10) },
              reloadStranded: {})
    }

    @Test func haltUsesRawRunningAndRequiresTwoTapsOnTheSameSet() {
        let running = PreviewData.session(id: "running")
        let blocked = PreviewData.session(id: "blocked", status: .init(known: .blocked))
        #expect(HerdPartition.displayStatus(blocked, workingBlocked: ["blocked": true]).known == .running)
        #expect(QueueActionPresentation.haltable([running, blocked]) == ["running"])
        var arm = QueueHaltConfirmation()
        let tap1 = arm.tap(sessions: [], now: 0)
        #expect(!tap1)
        #expect(!arm.isArmed)
        let tap2 = arm.tap(sessions: [running, blocked], now: 1)
        #expect(!tap2)
        #expect(arm.isArmed)
        let tap3 = arm.tap(sessions: [running, blocked], now: 2)
        #expect(tap3)
        let tap4 = arm.tap(sessions: [running], now: 3)
        #expect(!tap4)
        let tap5 = arm.tap(sessions: [PreviewData.session(id: "new")], now: 4)
        #expect(!tap5)
        let tap6 = arm.tap(sessions: [running], now: 4_000)
        #expect(!tap6)
        arm.disarm()
        #expect(!arm.isArmed)
    }

    @Test func haltFailureStaysVisibleUntilExplicitRetryAndNeverReportsZeroSuccess() async {
        let state = QueueActionState()
        var calls = 0
        var api = commands
        api.halt = { calls += 1; throw ShepherdError.upstreamFailure(code: nil, message: "HTTP 500") }
        #expect(await state.run(.halt, commands: api, isCurrent: { true }) == false)
        #expect(state.gate.message?.contains(L.t("halt_failed")) == true)
        #expect(state.notices.isEmpty && calls == 1)
        for _ in 0..<10 { await Task.yield() }
        #expect(state.gate.message != nil)
        api.halt = { calls += 1; return .init(halted: 2) }
        #expect(await state.run(.halt, commands: api, isCurrent: { true }))
        #expect(calls == 2 && state.gate.message == nil)
        #expect(state.notices == [L.t("halt_done", "2")])
    }

    @Test func retrySelectionIsSeededOnceAndHaltFramesCannotReselectUncheckedRows() async throws {
        let empty = QueuesReads(held: { [] }, done: { [] }, recaps: { [:] }, stranded: { [] }, refreshUpNext: {})
        let fixture = try QueueFixture(empty)
        defer { fixture.close() }
        var halted = PreviewData.session(id: "halted")
        halted.haltReason = .init(known: .usageLimit)
        let other = PreviewData.session(id: "other")
        var selection = QueueTargetSelection(sessions: [halted, other], preselectUsage: true)
        #expect(selection.selected == ["halted"])
        selection.toggle("halted")
        fixture.store.apply(try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"event":"session:halt","data":{"id":"halted","haltReason":"usage_limit","haltedAt":2}}"#.utf8)))
        #expect(await queueSettle { fixture.model.retrySelectionGeneration == 1 })
        #expect(selection.ids(in: [halted, other]).isEmpty)
        #expect(QueueTargetSelection(sessions: [halted, other], preselectUsage: true).selected == ["halted"])
        selection.toggle("other")
        #expect(selection.ids(in: [halted, other]) == ["other"])
        #expect(selection.ids(in: [halted]).isEmpty)
    }

    @Test func retrySendsTheSelectedIDsAndClientLocalizedSteer() async {
        let state = QueueActionState()
        var sent: [String] = []
        var text = ""
        var api = commands
        api.retry = { sent = $0; text = $1; return .init(resumed: 1, steered: 2, total: 3) }
        #expect(await state.run(.retry(["b", "a"]), commands: api, isCurrent: { true }))
        #expect(sent == ["b", "a"] && text == L.t("retry_continue_steer"))
        #expect(state.notices == [L.t("toast_retry_done", "1", "2", "3")])
    }

    @Test func restoreReturnsLocalizedSuccessAndDoesNotInventALiveSession() async {
        let state = QueueActionState()
        let session = PreviewData.session(id: "done", desig: "TASK-42", status: .init(known: .archived))
        var restored: [String] = []
        var api = commands
        api.restore = { restored.append($0); return session }
        #expect(await state.run(.restore(session), commands: api, isCurrent: { true }))
        #expect(restored == ["done"] && state.notices == [L.t("restore_done", "TASK-42")])
    }

    @Test(arguments: ["in_progress", "not_archived", "cannot_restore", "branch_gone", "branch_in_use", "spawn_refused", "future"])
    func restoreConflictHasLocalizedFailure(code: String) async throws {
        let state = QueueActionState()
        let conflict = try JSONDecoder().decode(RestoreConflict.self,
            from: JSONEncoder().encode(["code": code, "error": "server detail"]))
        var api = commands
        api.restore = { _ in throw conflict }
        #expect(await state.run(.restore(PreviewData.session()), commands: api, isCurrent: { true }) == false)
        let expected: [String: StaticString] = ["in_progress": "restore_in_progress", "not_archived": "restore_not_archived",
            "cannot_restore": "restore_cannot", "branch_gone": "restore_branch_gone", "branch_in_use": "restore_branch_in_use"]
        #expect(state.gate.message == L.t(expected[code] ?? "restore_failed"))
        #expect(state.notices.isEmpty)
    }

    @Test func reviveRereadsAndBannerClearsOnlyWithAnEmptyAuthoritativeCount() async throws {
        let model = QueuesModel(reads: .init(held: { [] }, done: { [] }, recaps: { [:] },
            stranded: { ["a", "b", "c"] }, refreshUpNext: {}))
        defer { model.teardown() }
        await model.refresh(recomputeUpNext: false)
        #expect(QueueActionPresentation.strandedMessage(model.stranded) == L.t("toast_sessions_stranded", "3"))
        let state = QueueActionState()
        var api = commands
        var calls: [String] = []
        api.revive = { calls.append("revive"); return .init(revived: 2, failed: 1) }
        api.reloadStranded = { calls.append("read"); try await model.reloadStranded() }
        model.reads.stranded = { ["c"] }
        #expect(await state.run(.revive, commands: api, isCurrent: { true }))
        #expect(calls == ["revive", "read"] && model.stranded == ["c"])
        #expect(state.notices == [L.t("toast_revive_all_result", "2", "1")])
        model.reads.stranded = { [] }
        try await model.reloadStranded()
        #expect(QueueActionPresentation.strandedMessage(model.stranded) == nil)
    }

    @Test func broadcastTrimsTextAndShowsDeliveredQueuedOfflineAndSkippedCounts() async {
        let state = QueueActionState()
        var sent: [String] = []
        var text = ""
        var api = commands
        api.broadcast = { sent = $0; text = $1; return .init(delivered: 1, queued: 2, offline: 3, skipped: 4, total: 10) }
        #expect(await state.run(.broadcast(["a", "b"], "  please continue \n"), commands: api, isCurrent: { true }))
        #expect(sent == ["a", "b"] && text == "please continue")
        #expect(state.notices == [L.t("toast_broadcast_result", "1", "2", "3"), L.t("toast_broadcast_skipped_terminals", "4")])
        #expect(await state.run(.broadcast([], "hi"), commands: api, isCurrent: { true }) == false)
        #expect(await state.run(.broadcast(["a"], " \n"), commands: api, isCurrent: { true }) == false)
    }

    @Test func broadcastWithNoDeliveryIsFailureExceptForSkippedTerminals() async {
        let state = QueueActionState()
        var api = commands
        api.broadcast = { _, _ in .init(delivered: 0, queued: 0, offline: 1, skipped: 0, total: 1) }
        #expect(await state.run(.broadcast(["a"], "go"), commands: api, isCurrent: { true }) == false)
        #expect(state.gate.message == L.t("broadcast_failed") && state.notices.isEmpty)
        api.broadcast = { _, _ in .init(delivered: 0, queued: 0, offline: 0, skipped: 1, total: 1) }
        #expect(await state.run(.broadcast(["a"], "go"), commands: api, isCurrent: { true }))
        #expect(state.notices == [L.t("toast_broadcast_skipped_terminals", "1")])
    }

    @Test(arguments: [false, true])
    func busyAndStaleCommandsCannotSendTwiceOrPublishALateResult(fail: Bool) async {
        let pause = LoadGate()
        var current = true
        var calls = 0
        var reads = 0
        let state = QueueActionState()
        var api = commands
        api.revive = {
            calls += 1
            await pause.wait()
            if fail { throw ShepherdError.notFound }
            return .init(revived: 1, failed: 0)
        }
        api.reloadStranded = { reads += 1 }
        let pending = Task { await state.run(.revive, commands: api, isCurrent: { current }) }
        #expect(await settleDetail(until: { pause.isWaiting }))
        #expect(await state.run(.revive, commands: api, isCurrent: { current }) == false)
        current = false
        pause.open()
        #expect(await pending.value == false)
        #expect(calls == 1 && reads == 0 && state.notices.isEmpty && state.gate.message == nil)
        #expect(await state.run(.halt, commands: api, isCurrent: { false }) == false)
    }

    @Test func owedUsesPositiveSeamCountsIncludingArchivedIDsMissingFromTheLiveStore() {
        let rows = QueueActionPresentation.owed(["archived": 2, "zero": 0, "negative": -1, "other": 1])
        #expect(rows.map(\.id) == ["archived", "other"])
        #expect(rows.map(\.count) == [2, 1])
        #expect(QueueActionPresentation.owed([:]).isEmpty)
    }
}

@MainActor
struct QueueActionsReconciliationTests {
    private func model() -> QueuesModel {
        QueuesModel(reads: .init(held: { [] }, done: { [] }, recaps: { [:] },
            stranded: { [] }, refreshUpNext: {}))
    }

    @Test func commandRereadFencesAnOlderBackgroundStrandedRead() async throws {
        let state = model()
        defer { state.teardown() }
        let old = QueueReadGate()
        state.reads.stranded = { await old.enter(); return ["revived"] }
        let background = Task { await state.refresh(recomputeUpNext: false) }
        #expect(await queueSettle { await old.calls == 1 })
        state.reads.stranded = { [] }
        try await state.reloadStranded()
        await old.open()
        await background.value
        #expect(state.stranded.isEmpty)
    }

    @Test func teardownDropsALateStrandedCommandRead() async throws {
        let state = model()
        let pause = QueueReadGate()
        state.reads.stranded = { await pause.enter(); return ["old-server"] }
        let pending = Task { try await state.reloadStranded() }
        #expect(await queueSettle { await pause.calls == 1 })
        state.teardown()
        await pause.open()
        try await pending.value
        #expect(state.stranded.isEmpty)
    }

    @Test func failedStrandedRereadPreservesTheActionableBanner() async throws {
        let state = model()
        defer { state.teardown() }
        state.reads.stranded = { ["still-stranded"] }
        try await state.reloadStranded()
        state.reads.stranded = { throw ShepherdError.notFound }
        await #expect(throws: ShepherdError.notFound) { try await state.reloadStranded() }
        #expect(state.stranded == ["still-stranded"])
        #expect(QueueActionPresentation.strandedMessage(state.stranded) != nil)
    }
}
