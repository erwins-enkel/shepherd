import Foundation
import ShepherdKit
import Testing

@testable import ShepherdAppCore

/// Counts the snapshot reads a `SidebarModel` performed, from outside the model.
///
/// An actor rather than a class with a lock: `SidebarReads`' closures are
/// `@Sendable` and may run anywhere, and this plan forbids `@unchecked Sendable`
/// and `nonisolated(unsafe)` outside the kit's test `URLProtocol` stub.
actor ReadLedger {
    private(set) var count = 0
    func bump() { count += 1 }
}

/// A one-shot gate a gated read can park on, so a test can pin a `refresh()` mid-flight and act
/// while it is suspended there. An actor for the same reason `ReadLedger` is one: the gated
/// closures are `@Sendable` and this plan forbids `@unchecked Sendable`/`nonisolated(unsafe)`.
actor Signal {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        opened = true
        for waiter in waiters { waiter.resume() }
        waiters.removeAll()
    }
}

/// Yields until `condition` holds, bounded by a 10 s deadline rather than a
/// yield count (a loaded simulator can starve the awaited work for many hops);
/// an explicit `yields` keeps a count bound for checks that something does
/// *not* happen.
/// Reports whether it held. Everything under test is main-actor work a yield lets run, so there
/// is nothing here to sleep for. A file-local twin of the helper `AppModelTests` and
/// `AppExtensionTests` each keep private to themselves.
@MainActor
private func settle(until condition: () async -> Bool, yields: Int? = nil) async -> Bool {
    if let yields {
        for _ in 0..<yields {
            if await condition() { return true }
            await Task.yield()
        }
        return await condition()
    }
    let deadline = ContinuousClock.now + .seconds(10)
    while ContinuousClock.now < deadline {
        if await condition() { return true }
        await Task.yield()
    }
    return await condition()
}

extension CoreSeamTests {
@MainActor
struct SidebarModelTests {
    /// Driven through the injectable reads rather than the network: Task 2 proves the HTTP mapping,
    /// this suite is about state.
    private func model(_ reads: SidebarReads = .stub) -> SidebarModel {
        SidebarModel(reads: reads, now: { 1_800_000_000_000 })
    }

    @Test func repoToggleReplacesUnlessAdditiveAndClearsOnRepeat() {
        let m = model()
        m.toggleRepo("/repos/a", additive: false)
        #expect(m.selectedRepos == ["/repos/a"])
        m.toggleRepo("/repos/b", additive: false)
        #expect(m.selectedRepos == ["/repos/b"])
        m.toggleRepo("/repos/a", additive: true)
        #expect(m.selectedRepos == ["/repos/a", "/repos/b"])
        m.toggleRepo("/repos/a", additive: true)
        #expect(m.selectedRepos == ["/repos/b"])
        m.toggleRepo("/repos/b", additive: false)
        #expect(m.selectedRepos.isEmpty, "clicking the only selected repo clears the filter")
    }

    @Test func collapseTogglesPerStage() {
        let m = model()
        m.toggleCollapsed(.ready)
        #expect(m.collapsedStages == [.ready])
        m.toggleCollapsed(.ready)
        #expect(m.collapsedStages.isEmpty)
    }

    @Test func refreshInstallsEverySnapshot() async {
        let m = model()
        await m.refresh()
        #expect(m.workingBlocked == ["s1": true])
        #expect(m.holds["s1"]?.code.known == .quotaRework)
        #expect(m.usage?.limits.session5h?.pct == 42)
    }

    @Test func aRefreshThatLostItsRaceIsDropped() async {
        let m = model()
        m.armStaleGeneration()
        await m.refresh()
        #expect(m.workingBlocked.isEmpty, "a superseded snapshot must not be installed")
    }

    @Test func aFailedReadLeavesTheLastSnapshotInPlace() async {
        let m = model()
        await m.refresh()
        m.reads = .failing
        await m.refresh()
        #expect(m.workingBlocked == ["s1": true], "a failed read must not blank the sidebar")
    }

    @Test func groupsTalliesAndTheLensAllGoThroughHerdPartition() {
        let m = model()
        m.install(sessions: [
            PreviewData.session(id: "a", status: SessionStatus(known: .idle)),
            PreviewData.session(id: "b", status: SessionStatus(known: .running)),
            PreviewData.session(id: "c", status: SessionStatus(known: .archived)),
        ])
        #expect(m.tallies == HerdTallies(active: 1, idle: 1, blocked: 0, total: 2))
        #expect(m.groups.map(\.stage) == [.active])
        m.lens = .ready
        #expect(m.sessions.map(\.id) == ["a"])
    }

    /// `ui/src/lib/display-status.ts:3-10` — `displayStatus` is "the single source of truth for
    /// everything that RENDERS a status". The tallies and the Ready lens already went through it;
    /// the row did not, so a blocked-but-working session was counted active in the header and
    /// painted "Blockiert" one line below. `rendered` is what the group view hands `SessionRow`.
    @Test func aBlockedSessionFlaggedWorkingRendersAsRunning() async {
        let m = model()
        await m.refresh()
        #expect(m.workingBlocked == ["s1": true])

        let flagged = PreviewData.session(id: "s1", status: SessionStatus(known: .blocked))
        #expect(m.rendered(flagged).status.known == .running)
        #expect(m.rendered(flagged).id == "s1", "only the status is repainted")

        let unflagged = PreviewData.session(id: "s2", status: SessionStatus(known: .blocked))
        #expect(m.rendered(unflagged).status.known == .blocked)

        // "The flag only ever upgrades blocked — a stale entry on a non-blocked session is inert."
        let idle = PreviewData.session(id: "s1", status: SessionStatus(known: .idle))
        #expect(m.rendered(idle).status.known == .idle)

        // The whole point of the fix: the row and the header now say the same thing.
        m.install(sessions: [flagged])
        #expect(m.tallies == HerdTallies(active: 1, idle: 0, blocked: 0, total: 1))
    }

    // MARK: - The event tap

    /// Counts `workingBlocked()` only, so the ledger counts refreshes, not reads.
    private func counting(_ ledger: ReadLedger) -> SidebarReads {
        SidebarReads(
            workingBlocked: {
                await ledger.bump()
                return [:]
            },
            holds: { [:] },
            blocks: { [:] },
            usage: {
                UsageLimitsResponse(
                    limits: UsageLimits(perModelWeek: [], stale: false, subscriptionOnly: false),
                    projections: [])
            })
    }

    /// A model built the way `AppModel` builds it — over a real `SessionStore`, so
    /// the tap under test is the store's own `events()` fan-out and not a stub.
    /// The store is never `start()`ed, so nothing here opens a socket; frames go in
    /// through `apply(_:)`, which is what the socket would have called.
    ///
    /// `reads` is swapped before the first suspension point, so the bootstrap
    /// refresh the production initializer fires already counts through the ledger
    /// and never touches the network.
    private func live() throws -> (SidebarModel, SessionStore, AppModel, ReadLedger) {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        let profile = ServerProfile(
            name: "tap", baseURL: URL(string: "https://tap.example.ts.net")!, mode: .remote)
        let store = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
        let ledger = ReadLedger()
        let model = SidebarModel(store: store, app: app)
        model.reads = counting(ledger)
        return (model, store, app, ledger)
    }

    @Test func theProductionInitBootstrapsOneRefreshAndSubscribes() async throws {
        let (model, store, app, ledger) = try live()
        #expect(model.isSubscribed)
        #expect(await settle(until: { await ledger.count >= 1 }))
        #expect(await ledger.count == 1)
        model.teardown()
        _ = store
        _ = app
    }

    /// The two frames the sidebar's contract block declares are not in `EventName`,
    /// so they arrive as `.unknown`; the sidebar re-reads on each and ignores the
    /// rest, because every other frame the store already applies to its own state.
    @Test func eachSidebarFrameTriggersOneReReadAndOtherFramesTriggerNone() async throws {
        let (model, store, app, ledger) = try live()
        #expect(await settle(until: { await ledger.count >= 1 }))

        store.apply(.unknown(name: "held:changed", payload: nil))
        #expect(await settle(until: { await ledger.count >= 2 }))

        store.apply(.unknown(name: "session:working-blocked", payload: nil))
        #expect(await settle(until: { await ledger.count >= 3 }))

        store.apply(.unknown(name: "epic:changed", payload: nil))
        #expect(!(await settle(until: { await ledger.count >= 4 }, yields: 50)))
        #expect(await ledger.count == 3, "a frame this stream does not declare re-reads nothing")

        model.teardown()
        _ = store
        _ = app
    }

    @Test func teardownStopsTheReReads() async throws {
        let (model, store, app, ledger) = try live()
        #expect(await settle(until: { await ledger.count >= 1 }))

        model.teardown()
        #expect(!model.isSubscribed)
        store.apply(.unknown(name: "held:changed", payload: nil))

        #expect(!(await settle(until: { await ledger.count >= 2 }, yields: 50)))
        _ = app
    }

    /// A burst arriving while a `refresh()` is already in flight must coalesce into exactly one
    /// follow-up read, not fan out one per frame. The read is held open on a gate so the burst is
    /// guaranteed to land entirely while it is in flight — without that, a fast (un-gated) read can
    /// finish before the next buffered frame is even processed, which is close to what
    /// `theProductionInitBootstrapsOneRefreshAndSubscribes`-style timing already covers and would
    /// prove nothing extra here.
    @Test func aBurstOfFramesCoalescesIntoExactlyOneFollowUpRead() async throws {
        let (model, store, app, ledger) = try live()
        #expect(await settle(until: { await ledger.count >= 1 }))

        let entered = ReadLedger()
        let gate = Signal()
        // Safe to swap in here, after the settle above: the production bootstrap already ran to
        // completion against the *original* `reads` (that is what `ledger.count >= 1` just
        // confirmed), so this assignment only ever governs the `requestRefresh()` reads the
        // `store.apply` burst below triggers — never races the bootstrap's own first read.
        model.reads = gated(entered, gate)

        for _ in 0..<10 { store.apply(.unknown(name: "held:changed", payload: nil)) }
        // Nothing here depends on the gate, so this drains the whole burst through
        // `requestRefresh()` regardless of how many yields it actually needs — the first frame's
        // read is held open by the gate and cannot complete early no matter how long this waits.
        _ = await settle(until: { false }, yields: 300)
        #expect(await entered.count == 1, "only the first frame of the burst should start a read")

        await gate.open()
        _ = await settle(until: { false }, yields: 300)

        let finalEntered = await entered.count
        #expect(
            finalEntered == 2,
            "ten frames arriving while a read was in flight produced \(finalEntered) reads instead of coalescing into one follow-up read"
        )

        model.teardown()
        _ = store
        _ = app
    }

    /// A block CLEAR is `blocks[id] = nil` in `SessionStore.apply`, and `block(for:)` falls back to
    /// this model's own map when the store has none — so without mirroring the frame, a bootstrap
    /// snapshot that still carried the block would win that fallback and keep the quota badge lit
    /// forever. Neither `held:changed` nor `session:working-blocked` is emitted for a block clear,
    /// so no re-read would ever wash it out either.
    @Test func aClearedBlockIsNotResurrectedFromTheBootstrapSnapshot() async throws {
        let (model, store, app, ledger) = try live()
        #expect(await settle(until: { await ledger.count >= 1 }))

        let reason = BlockReason(
            shape: .init(value1: .quota), options: [], tail: [], quotaKind: .init(value1: .rework))

        // A bootstrap read that saw the block — the stale snapshot the `??` used to fall back to.
        model.reads = SidebarReads(
            workingBlocked: { [:] }, holds: { [:] }, blocks: { ["s1": reason] },
            usage: {
                UsageLimitsResponse(
                    limits: UsageLimits(perModelWeek: [], stale: false, subscriptionOnly: false),
                    projections: [])
            })
        await model.refresh()
        #expect(model.blocks["s1"] != nil, "the snapshot carries the block")
        #expect(model.block(for: "s1") != nil)

        // The socket confirms it, then clears it.
        store.apply(.sessionBlock(Components.Schemas.SessionBlockEvent(id: "s1", block: reason)))
        #expect(await settle(until: { model.blocks["s1"] != nil }))
        #expect(model.block(for: "s1") != nil)

        store.apply(.sessionBlock(Components.Schemas.SessionBlockEvent(id: "s1", block: nil)))
        #expect(
            await settle(until: { model.block(for: "s1") == nil }),
            "a cleared block must not be resurrected from the bootstrap snapshot")
        #expect(store.blocks["s1"] == nil)
        #expect(model.blocks["s1"] == nil, "the fallback map follows the clear")

        model.teardown()
        _ = app
    }

    // MARK: - Reconciliation on reconnect

    @Test func aReconnectReadSupersedesAStaleUsagePushAndTheNextPushWins() async throws {
        let (model, store, app, _) = try live()
        defer {
            model.teardown()
            app.teardown()
        }
        // Await the installed bootstrap, not merely the start of one of its four reads.
        try #require(await settle(until: { model.usage != nil }))

        let box = ConnectionBox()
        var observed: ConnectionState?
        model.watchConnection {
            observed = box.state
            return box.state
        }
        try #require(await settle(until: { observed == .idle }))
        model.reads = .stub
        box.state = .live
        try #require(await settle(until: { model.usage?.limits.session5h?.pct == 42 }))

        let push = UsageLimits(
            session5h: .init(pct: 7, resetAt: 1_800_000_000_000),
            perModelWeek: [], stale: false, subscriptionOnly: false)
        store.apply(.usageLimits(push))
        #expect(model.limits?.session5h?.pct == 7)

        box.state = .offline(message: "down")
        try #require(await settle(until: { observed == box.state }))
        let entered = ReadLedger()
        let gate = Signal()
        var reads = SidebarReads.stub
        reads.usage = {
            await entered.bump()
            await gate.wait()
            return UsageLimitsResponse(
                limits: UsageLimits(
                    session5h: .init(pct: 95, resetAt: 1_800_000_000_000),
                    perModelWeek: [], stale: false, subscriptionOnly: false),
                projections: [])
        }
        model.reads = reads
        box.state = .live
        let started = await settle(until: { await entered.count == 1 })
        #expect(started, "re-entering live starts the gated usage re-read")
        #expect(model.limits?.session5h?.pct == 7, "keep the last value until the read lands")
        await gate.open()
        try #require(await settle(until: { model.usage?.limits.session5h?.pct == 95 }))
        #expect(model.limits?.session5h?.pct == 95, "the REST receipt supersedes the stale 7% push")
        #expect(UsageMeter.bars(try #require(model.limits)).first?.pct == 95)

        // Even a push equal to the OLD push must win: equality is not a receipt timestamp.
        store.apply(.usageLimits(push))
        #expect(model.limits?.session5h?.pct == 7, "connected pushes win immediately again")
        model.reads = .failing
        await model.refresh()
        #expect(model.limits?.session5h?.pct == 7, "a failed read cannot replace the last receipt")
    }

    @Test(arguments: [7.0, 99.0])
    func aPushAfterUsageReceiptWinsWhileHoldsIsStillPending(newerPct: Double) async throws {
        let (model, store, app, _) = try live()
        defer {
            model.teardown()
            app.teardown()
        }
        try #require(await settle(until: { model.usage != nil }))
        let stale = UsageLimits(
            session5h: .init(pct: 7, resetAt: 1_800_000_000_000),
            perModelWeek: [], stale: false, subscriptionOnly: false)
        store.apply(.usageLimits(stale))

        let holdsGate = Signal()
        let usageGate = Signal()
        var reads = SidebarReads.stub
        reads.holds = {
            await holdsGate.wait()
            return [:]
        }
        reads.usage = {
            await usageGate.wait()
            var limits = stale
            limits.session5h?.pct = 95
            return UsageLimitsResponse(limits: limits, projections: [])
        }
        model.reads = reads
        let receipts = model.usageReadCount
        let refresh = Task { await model.refresh() }
        // Wait for the actual main-actor receipt, not merely for the usage closure to return.
        await usageGate.open()
        let received = await settle(until: { model.usageReadCount == receipts + 1 })
        #expect(received, "usage receipt is processed independently of the gated holds route")
        #expect(model.limits?.session5h?.pct == 7, "no flicker while holds is pending")

        var newer = stale
        newer.session5h?.pct = newerPct
        store.apply(.usageLimits(newer))
        #expect(model.limits?.session5h?.pct == newerPct)
        await holdsGate.open()
        await refresh.value
        #expect(model.usage?.limits.session5h?.pct == 95, "the REST snapshot was accepted")
        #expect(store.usageLimits?.session5h?.pct == newerPct)
        #expect(model.limits?.session5h?.pct == newerPct)
        #expect(UsageMeter.bars(try #require(model.limits)).first?.pct == newerPct)
    }

    @Test(arguments: [false, true])
    func usageReceiptAfterAPushIsCommittedOnlyIfHoldsSucceeds(holdsFails: Bool) async throws {
        let (model, store, app, _) = try live()
        defer {
            model.teardown()
            app.teardown()
        }
        try #require(await settle(until: { model.usage != nil }))
        let holdsGate = Signal()
        let usageGate = Signal()
        let entered = ReadLedger()
        var reads = SidebarReads.stub
        reads.holds = {
            await holdsGate.wait()
            if holdsFails { throw CancellationError() }
            return [:]
        }
        reads.usage = {
            await entered.bump()
            await usageGate.wait()
            return UsageLimitsResponse(
                limits: UsageLimits(
                    session5h: .init(pct: 95, resetAt: 1_800_000_000_000),
                    perModelWeek: [], stale: false, subscriptionOnly: false),
                projections: [])
        }
        model.reads = reads
        let receipts = model.usageReadCount
        let refresh = Task { await model.refresh() }
        #expect(await settle(until: { await entered.count == 1 }))
        // This push arrives after refresh starts but before REST usage returns.
        store.apply(.usageLimits(UsageLimits(
            session5h: .init(pct: 7, resetAt: 1_800_000_000_000),
            perModelWeek: [], stale: false, subscriptionOnly: false)))
        await usageGate.open()
        #expect(await settle(until: { model.usageReadCount == receipts + 1 }))
        #expect(model.limits?.session5h?.pct == 7, "do not publish a partially read snapshot")
        await holdsGate.open()
        await refresh.value
        #expect(store.usageLimits?.session5h?.pct == (holdsFails ? 7 : 95))
        #expect(model.limits?.session5h?.pct == (holdsFails ? 7 : 95))
    }

    /// The sidebar reconciles on the same signal the store does. `SessionStore` re-reads its own
    /// snapshot on every reconnect; these four snapshots ride along on the connection entering
    /// `.live`, so a `working-blocked` flag that flipped while the socket was down cannot stay
    /// wrong indefinitely.
    @Test func enteringLiveTriggersExactlyOneReRead() async {
        let ledger = ReadLedger()
        let m = SidebarModel(reads: counting(ledger), now: { 0 })
        let box = ConnectionBox()
        m.watchConnection { box.state }

        #expect(
            !(await settle(until: { await ledger.count >= 1 }, yields: 50)),
            "the state at arm time is the baseline, not a transition")

        box.state = .connecting
        #expect(!(await settle(until: { await ledger.count >= 1 }, yields: 50)))

        box.state = .live
        #expect(await settle(until: { await ledger.count >= 1 }))
        #expect(await ledger.count == 1)

        // Still live: a write that does not change the answer re-reads nothing.
        box.state = .live
        #expect(!(await settle(until: { await ledger.count >= 2 }, yields: 50)))
        #expect(await ledger.count == 1)

        // A drop and a genuine RE-entry is a second reconciliation. The two writes need a turn
        // between them: `withObservationTracking` reports that *something* changed, not what it
        // changed to, so two writes in one main-actor turn coalesce and the watcher would only ever
        // see the newer value. A real drop and reconnect are always turns apart.
        box.state = .offline(message: "down")
        _ = await settle(until: { false }, yields: 20)
        box.state = .live
        #expect(await settle(until: { await ledger.count >= 2 }))
        #expect(await ledger.count == 2)

        m.teardown()
        box.state = .offline(message: "down")
        _ = await settle(until: { false }, yields: 20)
        box.state = .live
        #expect(!(await settle(until: { await ledger.count >= 3 }, yields: 50)))
        #expect(await ledger.count == 2, "teardown() cancels the connection watcher too")
    }

    /// The other half of the same mechanism: one flaky route discards all four reads, and before
    /// this the failure had no retry at all — a failed bootstrap left the header with no usage
    /// meter and no badges until a tap frame happened to arrive, possibly never.
    @Test func aFailedBootstrapIsRetriedOnTheNextLiveTransition() async {
        let m = SidebarModel(reads: .failing, now: { 0 })
        await m.refresh()
        #expect(m.workingBlocked.isEmpty, "the bootstrap read failed")
        #expect(m.usage == nil)

        let box = ConnectionBox()
        m.watchConnection { box.state }
        m.reads = .stub
        box.state = .live

        #expect(await settle(until: { !m.workingBlocked.isEmpty }))
        #expect(m.workingBlocked == ["s1": true])
        #expect(m.usage?.limits.session5h?.pct == 42)
        m.teardown()
    }

    /// `teardown()` must END the connection watcher's loop, not merely cancel the task around it.
    /// The regression guard for the `AsyncStream` shape: with the old bare
    /// `withCheckedContinuation` the loop stayed parked forever — `Task.cancel()` cannot resume a
    /// checked continuation, and `SessionStore.stop()` writes `connection` only when the state
    /// actually moves — so the model, the reader closure and an observation registration inside
    /// the store survived every profile switch and every closed window.
    @Test func teardownEndsTheConnectionWatcher() async {
        let m = model()
        let box = ConnectionBox()
        m.watchConnection { box.state }
        #expect(m.isWatchingConnection)

        // Parked on the stream: no write since the arm, so nothing has woken it.
        _ = await settle(until: { m.isWatchingConnection == false }, yields: 50)
        #expect(m.isWatchingConnection, "the watcher waits rather than falling out of its loop")

        m.teardown()
        #expect(
            await settle(until: { m.isWatchingConnection == false }),
            "teardown() finishes the stream, so the suspended loop can actually end")
    }

    /// Re-arming installs the replacement synchronously, while the predecessor is still suspended;
    /// the predecessor then wakes on its finished stream and runs its cleanup. Without the
    /// `connectionWatcherToken` check, that cleanup would clear `isWatchingConnection` over a
    /// watcher that is very much alive. Mirrors
    /// `AppModelTests.rearmingTheWatcherLeavesTheReplacementReportingItself`.
    @Test func rearmingTheWatcherLeavesTheReplacementReportingItself() async {
        let ledger = ReadLedger()
        let m = SidebarModel(reads: counting(ledger), now: { 0 })
        let box = ConnectionBox()

        m.watchConnection { box.state }
        #expect(m.isWatchingConnection)

        // Arm a second watcher over the top, then give the first one every chance to unwind and
        // clear the flag it no longer owns.
        m.watchConnection { box.state }
        _ = await settle(until: { m.isWatchingConnection == false }, yields: 200)
        #expect(m.isWatchingConnection)

        // And exactly one watcher is live: a single `.live` arrival re-reads once, not twice.
        box.state = .live
        #expect(await settle(until: { await ledger.count >= 1 }))
        _ = await settle(until: { await ledger.count >= 2 }, yields: 50)
        #expect(await ledger.count == 1, "the superseded watcher must not re-read alongside it")

        // The live watcher still answers to teardown.
        m.teardown()
        #expect(await settle(until: { m.isWatchingConnection == false }))
    }

    /// Gated reads: the closure signals `entered` before parking on `gate`, so a test can pin a
    /// `refresh()` mid-flight, act while it is suspended, then let it complete.
    private func gated(_ entered: ReadLedger, _ gate: Signal) -> SidebarReads {
        SidebarReads(
            workingBlocked: {
                await entered.bump()
                await gate.wait()
                return ["s1": true]
            },
            holds: { [:] },
            blocks: { [:] },
            usage: {
                UsageLimitsResponse(
                    limits: UsageLimits(perModelWeek: [], stale: false, subscriptionOnly: false),
                    projections: [])
            })
    }

    /// H1: a completion that lands after the whole activation has moved on (a profile switch or a
    /// teardown, both of which bump `AppModel.activationGeneration`) must not be installed into this
    /// model — even though nothing tore this particular model down, since it was built directly
    /// rather than through `AppModel.register(_:)`/`makeExtensions(store:)`. Before this fix
    /// `refresh()` had no way to notice: it only ever compared its own per-instance `generation`.
    @Test func aSnapshotThatCompletesAfterTheActivationHasMovedOnIsDropped() async throws {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        let profile = ServerProfile(
            name: "tap", baseURL: URL(string: "https://tap.example.ts.net")!, mode: .remote)
        let store = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
        let entered = ReadLedger()
        let gate = Signal()
        let model = SidebarModel(store: store, app: app)
        // `init` only *schedules* `bootstrap = Task { … }`; a `Task` never runs synchronously
        // inside its enclosing scope, so nothing in that task body can execute until this
        // synchronous initializer call returns and the main actor's run loop gets a chance to pick
        // it up. That guarantees this assignment — still on the same, uninterrupted main-actor
        // turn as `init` — lands before the bootstrap's first `await`, so it is `gated`'s reads,
        // not the (real) production ones, that the task actually calls.
        model.reads = gated(entered, gate)

        // The bootstrap refresh is now parked inside `workingBlocked()`, before its first `await`
        // captured `app.activationGeneration`.
        #expect(await settle(until: { await entered.count >= 1 }))

        // Bumps `app.activationGeneration`, exactly as `activate(_:)` and a real profile switch do.
        app.teardown()

        // Let the parked refresh proceed to completion.
        await gate.open()
        _ = await settle(until: { false }, yields: 300)

        #expect(
            model.workingBlocked.isEmpty,
            "a snapshot from a superseded activation must not be installed")
        #expect(store.usageLimits == nil, "a rejected activation cannot reconcile usage either")

        model.teardown()
        _ = store
    }
}
}
