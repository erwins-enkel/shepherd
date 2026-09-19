import Foundation
import Observation
import ShepherdKit

/// The four reads the sidebar bootstraps from, behind closures so the unit tests need no network
/// and no URL-protocol stub.
struct SidebarReads: Sendable {
    var workingBlocked: @Sendable () async throws -> [String: Bool]
    var holds: @Sendable () async throws -> [String: HoldReason]
    var blocks: @Sendable () async throws -> [String: BlockReason]
    var usage: @Sendable () async throws -> UsageLimitsResponse

    static func live(_ client: ShepherdClient) -> SidebarReads {
        SidebarReads(
            workingBlocked: { try await client.workingBlocked() },
            holds: { try await client.holds() },
            blocks: { try await client.blocks() },
            usage: { try await client.usage() })
    }
}

/// The Herd sidebar's state. `AppModel` owns it through the `AppExtension` seam — created after the
/// store exists, torn down with it — so it never outlives the store it reads. Both async entry
/// points it owns — the one-shot bootstrap and the event-driven re-reads — are cancelled in
/// `teardown()`, and every commit checks the `AppModel.activationGeneration` value captured before
/// its own first `await` against the model's live `app`, so a completion that lands after a profile
/// switch is dropped rather than installed into a model whose activation has already moved on — per
/// `AppExtension`'s "async work is the extension's own problem" contract.
@Observable
@MainActor
final class SidebarModel: AppExtension {
    private(set) var workingBlocked: [String: Bool] = [:]
    private(set) var holds: [String: HoldReason] = [:]
    private(set) var blocks: [String: BlockReason] = [:]
    private(set) var usage: UsageLimitsResponse?

    var lens: HerdLens = .all
    var selectedRepos: Set<String> = []
    var collapsedStages: Set<HerdStage> = []

    /// Stream S2's git classifier. Until S0-int assigns it, the ten git-decided stages stay empty.
    var gitStage: @MainActor (Session) -> HerdStage? = { _ in nil }

    /// Stream S2's "a critic run is in flight for this session" predicate. `HerdPartition.stageOf`
    /// consults it directly for `reviewerRunning`, on top of the Ready lens' own separate use of it
    /// in `shown`. Until S0-int assigns it, nothing is under review.
    var inReview: @MainActor (Session) -> Bool = { _ in false }

    @ObservationIgnored var reads: SidebarReads
    @ObservationIgnored private let now: @Sendable () -> Int
    @ObservationIgnored private weak var store: SessionStore?
    /// The app this model's activation belongs to. Weak, and `nil` for the test-only `reads:now:`
    /// initializer, which makes the `activationGeneration` guard in `refresh()` a no-op there.
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var offlineSessions: [Session] = []
    /// Bumped by every `refresh()`; a snapshot whose generation is no longer the newest is dropped
    /// rather than installed — the rule `SessionStore.refresh()` already uses. This guards races
    /// BETWEEN this model's own refreshes; `app.activationGeneration` (checked in `refresh()`)
    /// guards against a completion landing after the whole activation has moved on.
    @ObservationIgnored private var generation = 0
    #if DEBUG
        /// Arms a one-shot "a newer refresh landed while yours was in flight", for
        /// `aRefreshThatLostItsRaceIsDropped`. Never reachable outside tests, so it never ships.
        @ObservationIgnored private var staleOnce = false
    #endif
    @ObservationIgnored private var watcher: Task<Void, Never>?
    /// The one-shot bootstrap refresh the production initializer fires. Stored so `teardown()` can
    /// cancel it — previously it ran to completion even after the model was torn down.
    @ObservationIgnored private var bootstrap: Task<Void, Never>?
    /// The event-driven re-read `requestRefresh()` currently has in flight, if any.
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    /// Set when a tap frame arrives while `refreshTask` is already running, so a burst of frames
    /// collapses into one extra re-read instead of one per frame.
    @ObservationIgnored private var refreshPending = false

    var isSubscribed: Bool { watcher != nil }

    /// The production initializer the `AppExtension` seam calls.
    init(store: SessionStore, app: AppModel) {
        self.store = store
        self.app = app
        self.reads = .live(store.client)
        self.now = { Int(Date().timeIntervalSince1970 * 1_000) }
        // One authenticated socket, owned by `SessionStore` — `store.events()` is the fan-out seam
        // S0-prep delivered for exactly this: several independent taps on the one connection, each
        // seeing every frame. The sidebar needs two frames the store's own `applyNow` does not model
        // (`held:changed`, `session:working-blocked`) only as signals to re-read; it never calls
        // `setActive`, so it sends no presence frame and cannot fight the store's.
        subscribe(store)
        // Also the reconciliation `AppModel.register(_:)` demands of an extension built late: this
        // model derives nothing from the frames it may have missed, it re-reads all four snapshots
        // from scratch.
        bootstrap = Task { [weak self] in await self?.refresh() }
    }

    /// Test and preview initializer: no store, no socket, no app.
    init(reads: SidebarReads, now: @escaping @Sendable () -> Int) {
        self.reads = reads
        self.now = now
    }

    // MARK: - Derived state

    private var liveSessions: [Session] {
        (store?.sessions ?? offlineSessions).filter { $0.status.known != .archived }
    }

    /// Non-archived sessions, narrowed by the repo filter and then by the lens. `HerdPartition`'s
    /// `gitStage`/`inReview` parameters are themselves `@MainActor` closures, so `gitStage` and
    /// `inReview` pass straight through with no isolation bridging.
    var sessions: [Session] {
        HerdPartition.shown(
            HerdPartition.filter(liveSessions, repos: selectedRepos),
            lens: lens, workingBlocked: workingBlocked, now: now(), gitStage: gitStage,
            inReview: inReview)
    }

    /// Built from the unfiltered list, so a repo whose sessions the lens hides keeps its chip.
    var chips: [HerdRepoChip] { HerdPartition.repoChips(store?.sessions ?? offlineSessions) }

    var groups: [HerdGroup] {
        HerdPartition.groups(sessions, now: now(), gitStage: gitStage, inReview: inReview)
    }

    var tallies: HerdTallies {
        HerdPartition.tallies(
            HerdPartition.filter(liveSessions, repos: selectedRepos),
            workingBlocked: workingBlocked)
    }

    /// The `usage:limits` push the store applies wins over this model's bootstrap read: it is newer.
    var limits: UsageLimits? { store?.usageLimits ?? usage?.limits }

    /// The store's map when there is one — kept live by `session:block` — else the bootstrap read.
    func block(for id: String) -> BlockReason? { store?.blocks[id] ?? blocks[id] }

    // MARK: - Commands

    /// `nextRepoFilter` (`queue-strip.ts:80-82`): a plain click replaces the selection, or clears
    /// it when this repo was already the only one; shift-click toggles membership.
    func toggleRepo(_ path: String, additive: Bool) {
        if additive {
            if selectedRepos.contains(path) {
                selectedRepos.remove(path)
            } else {
                selectedRepos.insert(path)
            }
        } else {
            selectedRepos = selectedRepos == [path] ? [] : [path]
        }
    }

    func toggleCollapsed(_ stage: HerdStage) {
        if collapsedStages.contains(stage) {
            collapsedStages.remove(stage)
        } else {
            collapsedStages.insert(stage)
        }
    }

    /// Re-read all four snapshots. A failure keeps the previous snapshot: a blank sidebar is a worse
    /// answer than a slightly stale one, and `SessionStore` already owns the offline banner.
    func refresh() async {
        // Captured before the first `await` below, per `AppExtension`'s "async work is the
        // extension's own problem" contract: a profile switch or a teardown bumps
        // `app.activationGeneration`, and a completion that lands after must not write into a model
        // whose activation has already moved on. `nil` (no `app` — the test initializer) always
        // matches itself, so this guard is a no-op outside the production path.
        let activationSnapshot = app?.activationGeneration
        generation &+= 1
        let mine = generation
        do {
            async let flags = reads.workingBlocked()
            async let held = reads.holds()
            async let blocked = reads.blocks()
            async let limits = reads.usage()
            let loaded = try await (flags, held, blocked, limits)
            #if DEBUG
                if staleOnce {
                    staleOnce = false
                    generation &+= 1
                }
            #endif
            guard mine == generation else {
                Log.ui.debug("dropping a superseded sidebar snapshot")
                return
            }
            guard activationSnapshot == app?.activationGeneration else {
                Log.ui.debug("dropping a sidebar snapshot from an activation that has moved on")
                return
            }
            workingBlocked = loaded.0
            holds = loaded.1
            blocks = loaded.2
            usage = loaded.3
        } catch {
            Log.ui.debug(
                "sidebar snapshot read failed: \(String(describing: error), privacy: .public)")
        }
    }

    func teardown() {
        watcher?.cancel()
        watcher = nil
        bootstrap?.cancel()
        bootstrap = nil
        refreshTask?.cancel()
        refreshTask = nil
        refreshPending = false
    }

    /// Both frames arrive as `ServerEvent.unknown(name:payload:)`: the contract declares them under
    /// this stream's `x-shepherd-events` block but deliberately not in `EventName`, so the store
    /// hands them back as the raw name plus the undecoded `data` bytes. The sidebar only needs the
    /// name — a re-read is cheap and both frames exist solely to trigger one — so `payload` is
    /// discarded here rather than decoded through `HeldChangedEvent`/`SessionWorkingBlockedEvent`.
    /// No other frame is matched: everything else that moves a session between partitions
    /// (`session:new`, `session:status`, `session:archived`, `session:block`, `usage:limits`) the
    /// store already applies to state this model reads through, so `@Observable` republishes the
    /// derived groups with no read at all.
    ///
    /// A matching frame calls `requestRefresh()`, not `refresh()` directly: consuming the loop must
    /// stay cheap so a burst of buffered frames drains fast and collapses into one follow-up read
    /// rather than blocking the loop on a full network round trip per frame.
    ///
    /// The stream is created here and captured by the task rather than reached for through `store`,
    /// so the task holds no reference to the store and cancelling it drops the tap — which,
    /// per `SessionStore.events()`, is the only thing that unregisters one. `store.events()` also
    /// finishes on `stop()`, so this `for await` ends with the store even if `teardown()` never ran.
    private func subscribe(_ store: SessionStore) {
        let frames = store.events()
        watcher = Task { @MainActor [weak self] in
            for await event in frames {
                guard let self else { return }
                guard case .unknown(let name, _) = event,
                    name == "held:changed" || name == "session:working-blocked"
                else { continue }
                self.requestRefresh()
            }
        }
    }

    /// Coalesces a burst of tap frames into at most one extra `refresh()` on top of whichever is
    /// already running, instead of one full snapshot read per frame. A frame only ever means
    /// "something changed, re-read" — so N frames arriving while a read is already in flight need
    /// exactly one follow-up read afterwards, not N of them.
    private func requestRefresh() {
        guard refreshTask == nil else {
            refreshPending = true
            return
        }
        refreshTask = Task { [weak self] in
            guard let self else { return }
            await self.refresh()
            while self.refreshPending, !Task.isCancelled {
                self.refreshPending = false
                await self.refresh()
            }
            self.refreshTask = nil
        }
    }

    #if DEBUG
        /// Stands in for the store when the model was built without one.
        func install(sessions: [Session]) { offlineSessions = sessions }
        /// Arms a one-shot "a newer refresh landed while yours was in flight".
        func armStaleGeneration() { staleOnce = true }
    #endif
}

#if DEBUG
    private struct SidebarStubError: Error {}

    extension SidebarReads {
        static let stub = SidebarReads(
            workingBlocked: { ["s1": true] },
            holds: {
                ["s1": HoldReason(code: HoldCode(known: .quotaRework), params: .init(round: 2))]
            },
            blocks: { [:] },
            usage: {
                UsageLimitsResponse(
                    limits: UsageLimits(
                        session5h: .init(pct: 42, resetAt: 1_800_000_000_000),
                        week: .init(pct: 10, resetAt: 1_800_500_000_000),
                        perModelWeek: [], credits: nil, stale: false, calibratedAt: nil,
                        subscriptionOnly: false),
                    projections: [])
            })

        static let failing = SidebarReads(
            workingBlocked: { throw SidebarStubError() },
            holds: { throw SidebarStubError() },
            blocks: { throw SidebarStubError() },
            usage: { throw SidebarStubError() })
    }
#endif
