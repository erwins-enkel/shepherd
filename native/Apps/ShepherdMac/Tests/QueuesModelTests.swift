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
