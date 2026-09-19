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

    @Test func teardownEndsTheEventSubscription() {
        let m = model()
        m.teardown()
        #expect(!m.isSubscribed)
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
}
