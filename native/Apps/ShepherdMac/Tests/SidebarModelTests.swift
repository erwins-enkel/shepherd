import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

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

/// Yields until `condition` holds or the budget runs out, and reports whether it
/// held. Everything under test is main-actor work a yield lets run, so there is
/// nothing here to sleep for. A file-local twin of the helper `AppModelTests` and
/// `AppExtensionTests` each keep private to themselves.
@MainActor
private func settle(until condition: () async -> Bool, yields: Int = 500) async -> Bool {
    for _ in 0..<yields {
        if await condition() { return true }
        await Task.yield()
    }
    return await condition()
}

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
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
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
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        let profile = ServerProfile(
            name: "tap", baseURL: URL(string: "https://tap.example.ts.net")!, mode: .remote)
        let store = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
        let entered = ReadLedger()
        let gate = Signal()
        let model = SidebarModel(store: store, app: app)
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

        model.teardown()
        _ = store
    }
}
