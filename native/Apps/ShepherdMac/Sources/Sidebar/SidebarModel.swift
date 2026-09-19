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
/// store exists, torn down with it — so it never outlives the store it reads, and a completion
/// landing after a profile switch finds a model whose generation has already moved.
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

    /// Stream S2's git classifier. Until S0-int assigns it, the nine git-decided stages stay empty.
    var gitStage: @MainActor (Session) -> HerdStage? = { _ in nil }

    /// Stream S2's "a critic run is in flight for this session" predicate, which the Ready lens
    /// tests on its own (`HerdPartition.shown`). Until S0-int assigns it, nothing is under review.
    var inReview: @MainActor (Session) -> Bool = { _ in false }

    @ObservationIgnored var reads: SidebarReads
    @ObservationIgnored private let now: @Sendable () -> Int
    @ObservationIgnored private weak var store: SessionStore?
    @ObservationIgnored private var offlineSessions: [Session] = []
    /// Bumped by every `refresh()`; a snapshot whose generation is no longer the newest is dropped
    /// rather than installed — the rule `SessionStore.refresh()` already uses.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var staleOnce = false
    @ObservationIgnored private var watcher: Task<Void, Never>?

    var isSubscribed: Bool { watcher != nil }

    /// The production initializer the `AppExtension` seam calls.
    init(store: SessionStore, app: AppModel) {
        self.store = store
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
        Task { [weak self] in await self?.refresh() }
    }

    /// Test and preview initializer: no store, no socket.
    init(reads: SidebarReads, now: @escaping @Sendable () -> Int) {
        self.reads = reads
        self.now = now
    }

    // MARK: - Derived state

    private var liveSessions: [Session] {
        (store?.sessions ?? offlineSessions).filter { $0.status.known != .archived }
    }

    /// `HerdPartition` takes non-isolated closures, and a `@MainActor` one cannot be narrowed to
    /// them implicitly. Every caller below is a main-actor computed property calling synchronously
    /// into `HerdPartition`, so the isolation is real and `assumeIsolated` states it rather than
    /// hopping — the alternative would be widening `HerdPartition`'s signature, which stream S2
    /// also consumes.
    private var isolatedGitStage: (Session) -> HerdStage? {
        let classify = gitStage
        return { session in MainActor.assumeIsolated { classify(session) } }
    }

    private var isolatedInReview: (Session) -> Bool {
        let reviewing = inReview
        return { session in MainActor.assumeIsolated { reviewing(session) } }
    }

    /// Non-archived sessions, narrowed by the repo filter and then by the lens.
    var sessions: [Session] {
        HerdPartition.shown(
            HerdPartition.filter(liveSessions, repos: selectedRepos),
            lens: lens, workingBlocked: workingBlocked, now: now(), gitStage: isolatedGitStage,
            inReview: isolatedInReview)
    }

    /// Built from the unfiltered list, so a repo whose sessions the lens hides keeps its chip.
    var chips: [HerdRepoChip] { HerdPartition.repoChips(store?.sessions ?? offlineSessions) }

    var groups: [HerdGroup] {
        HerdPartition.groups(sessions, now: now(), gitStage: isolatedGitStage)
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
        generation &+= 1
        let mine = generation
        do {
            async let flags = reads.workingBlocked()
            async let held = reads.holds()
            async let blocked = reads.blocks()
            async let limits = reads.usage()
            let loaded = try await (flags, held, blocked, limits)
            if staleOnce {
                staleOnce = false
                generation &+= 1
            }
            guard mine == generation else {
                Log.ui.debug("dropping a superseded sidebar snapshot")
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
                await self.refresh()
            }
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
