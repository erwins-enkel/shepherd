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
    /// The repo chips the operator clicked. Raw — read `activeRepos` for the filter that is
    /// actually applied; a selection can outlive the chip that made it.
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
    /// Re-reads all four snapshots every time the store's connection (re-)enters `.live`. Stored
    /// alongside `watcher` so `teardown()` cancels it with everything else.
    @ObservationIgnored private var connectionWatcher: Task<Void, Never>?
    /// How the connection watcher is woken — and, crucially, how it is *ended*. `teardown()`
    /// finishes it; cancelling a task can never resume a `withCheckedContinuation`, which is what
    /// this watcher used to park on, so the loop stayed suspended forever holding this model and an
    /// observation registration inside the store: one leak per profile switch and per closed
    /// window. See `native/README.md`, "Never park a long-lived watcher on a bare
    /// `withCheckedContinuation`". Finishing twice, or yielding into a finished stream, is a no-op.
    @ObservationIgnored private var connectionSignal: AsyncStream<Void>.Continuation?
    /// True while *the current* connection watcher's loop is alive. Written by the task itself, so
    /// a test can prove the loop actually ended rather than merely that `Task.cancel()` was called
    /// on it. "Current" is load-bearing: an outgoing watcher may still be unwinding after its
    /// replacement armed itself, and it must not publish a false `false` over a live one — hence
    /// the `connectionWatcherToken` check, exactly as `AppModel.watchConnection` does it.
    @ObservationIgnored private(set) var isWatchingConnection = false
    /// Identifies the watcher `connectionWatcher` currently holds. Bumped by every
    /// `watchConnection(_:)`; a watcher whose captured value no longer matches has been superseded
    /// and owns nothing.
    @ObservationIgnored private var connectionWatcherToken = 0
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
        // Reconciliation after a gap, which `SessionStore.events()` spells out as the price of a
        // tap: a tap is not a guaranteed-complete log, so anything derived from frames must be
        // re-derivable from a fresh read. The store re-reads its own snapshot on every reconnect;
        // this watcher is how these four snapshots ride along, and it is the ONLY retry the
        // bootstrap below has — a bootstrap that failed (one flaky route discards all four reads)
        // is picked up by the next `.live` transition instead of leaving the header blank until a
        // tap frame happens to arrive.
        watchConnection { [weak store] in store?.connection }
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

    /// The repo paths that still have a chip — the same set `repoChips` is built from, minus the
    /// sort and the counts.
    private var chippedRepos: Set<String> { Set(liveSessions.map(\.repoPath)) }

    /// The repo filter as it actually applies: only paths that still have a chip to clear them
    /// with. Archiving a repo's last session drops its chip, and a selection left pointing at that
    /// repo would otherwise filter the list down to nothing with no control left to undo it — an
    /// invisible, unclearable filter. Intersecting here makes the stranded entry inert instead;
    /// `toggleRepo` drops it on the next click, and the web's click-to-replace / shift-to-toggle
    /// gesture is untouched.
    ///
    /// Short-circuited on the common "no filter" path so the usual render pays nothing for it.
    var activeRepos: Set<String> {
        selectedRepos.isEmpty ? [] : selectedRepos.intersection(chippedRepos)
    }

    /// Non-archived sessions, narrowed by the repo filter and then by the lens. `HerdPartition`'s
    /// `gitStage`/`inReview` parameters are themselves `@MainActor` closures, so `gitStage` and
    /// `inReview` pass straight through with no isolation bridging.
    var sessions: [Session] {
        HerdPartition.shown(
            HerdPartition.filter(liveSessions, repos: activeRepos),
            lens: lens, workingBlocked: workingBlocked, now: now(), gitStage: gitStage,
            inReview: inReview)
    }

    /// Built from the unfiltered list, so a repo whose sessions the lens hides keeps its chip.
    var chips: [HerdRepoChip] { HerdPartition.repoChips(store?.sessions ?? offlineSessions) }

    /// The web shows the rail only once there is something to choose between — plus, here, whenever
    /// a filter is actually applied, so the control that clears it can never be the thing that
    /// disappears. Takes the caller's already-computed chips rather than recomputing them: the view
    /// reads `chips` exactly once per render and this must not be a second pass.
    func showsRepoRail(_ chips: [HerdRepoChip]) -> Bool {
        chips.count >= 2 || !activeRepos.isEmpty
    }

    /// The session as it must RENDER: `HerdPartition.displayStatus` applied on top, so a blocked
    /// session that is in fact still producing output paints as running in the row exactly as it
    /// already counts as running in the tallies and in the Ready lens. `display-status.ts:3-10`
    /// calls that function "the single source of truth for everything that RENDERS a status"; the
    /// row used to be handed the raw session and contradict it.
    ///
    /// Display-only, per the same comment: nothing that *decides* anything reads this. `stageOf`,
    /// the archived filter in `liveSessions` and the Ready lens' own exclusion all keep reading the
    /// raw `session.status`, and this copy never reaches them — it is produced at the view boundary
    /// and nowhere else.
    func rendered(_ session: Session) -> Session {
        var copy = session
        copy.status = HerdPartition.displayStatus(session, workingBlocked: workingBlocked)
        return copy
    }

    var groups: [HerdGroup] {
        HerdPartition.groups(sessions, now: now(), gitStage: gitStage, inReview: inReview)
    }

    var tallies: HerdTallies {
        HerdPartition.tallies(
            HerdPartition.filter(liveSessions, repos: activeRepos),
            workingBlocked: workingBlocked)
    }

    /// The `usage:limits` push the store applies wins over this model's bootstrap read: it is newer.
    var limits: UsageLimits? { store?.usageLimits ?? usage?.limits }

    /// The store's map when there is one — kept live by `session:block` — else the bootstrap read.
    ///
    /// The `??` is only ever a *first-paint* fallback, and it can only stay one because `subscribe`
    /// mirrors `session:block` into this model's own `blocks` too. Without that mirror the two maps
    /// drift the moment a block clears: `SessionStore.apply` clears by writing `blocks[id] = nil`,
    /// the `??` then falls through to a bootstrap snapshot that still has the entry, and the quota
    /// badge stays on forever — neither `held:changed` nor `session:working-blocked` is emitted for
    /// a block clear, so nothing would ever re-read it away.
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
        connectionWatcher?.cancel()
        connectionWatcher = nil
        // The cancel above only sets a flag; this is what wakes the suspended loop so it can
        // observe it, let go of everything it captured and drop its observation registration.
        connectionSignal?.finish()
        connectionSignal = nil
        bootstrap?.cancel()
        bootstrap = nil
        refreshTask?.cancel()
        refreshTask = nil
        refreshPending = false
    }

    /// The tap does two different jobs, and the difference matters.
    ///
    /// **Two frames are re-read signals.** `held:changed` and `session:working-blocked` arrive as
    /// `ServerEvent.unknown(name:payload:)`: the contract declares them under this stream's
    /// `x-shepherd-events` block but deliberately not in `EventName`, so the store hands them back
    /// as the raw name plus the undecoded `data` bytes. The sidebar only needs the name — a re-read
    /// is cheap and both frames exist solely to trigger one — so `payload` is discarded here rather
    /// than decoded through `HeldChangedEvent`/`SessionWorkingBlockedEvent`.
    ///
    /// **Two frames are mirrored into `blocks`.** `session:block` and `session:archived` are the
    /// only frames this model keeps state from, and only because `block(for:)` falls back to this
    /// model's own map: `SessionStore.apply` clears a block by writing `blocks[id] = nil`, and
    /// without the mirror a stale bootstrap entry would win that fallback for good. Everything else
    /// that moves a session between partitions (`session:new`, `session:status`, `usage:limits`)
    /// the store already applies to state this model reads through, so `@Observable` republishes
    /// the derived groups with no read and no local copy at all.
    ///
    /// A re-read frame calls `requestRefresh()`, not `refresh()` directly: consuming the loop must
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
                switch event {
                case .unknown(let name, _)
                where name == "held:changed" || name == "session:working-blocked":
                    self.requestRefresh()
                // Mirrored, not re-read: `block(for:)` falls back to this model's own `blocks` map
                // when the store has no entry, and a block CLEAR is exactly "the store has no
                // entry". A stale bootstrap entry would win that `??` and keep the quota badge lit
                // for good. Applied straight from the frame rather than through `requestRefresh()`
                // because a clear has to land immediately — a network round trip later is a badge
                // the operator watches linger after the block is gone.
                case .sessionBlock(let payload):
                    self.blocks[payload.id] = payload.block
                // The store clears a block on archive too (`apply`, `.sessionArchived`), so the
                // fallback map has to follow it there as well.
                case .sessionArchived(let payload):
                    self.blocks[payload.id] = nil
                default:
                    continue
                }
            }
        }
    }

    /// Re-reads all four snapshots every time the connection (re-)enters `.live`.
    ///
    /// This is the sidebar's half of the reconciliation `SessionStore` already does for itself — it
    /// re-reads its own snapshot on every reconnect — and it covers two failures at once. A
    /// bootstrap that lost one of its four routes discarded all four and had no retry; and a
    /// `working-blocked` flag that flipped while the socket was down stayed wrong indefinitely,
    /// because the tap only listens for two frame names and a dropped frame is never redelivered.
    ///
    /// `ConnectionState` is `@Observable`-tracked on `SessionStore`, so this suspends on
    /// `withObservationTracking` and wakes on the next write — no timer, no missed transition.
    /// `withObservationTracking` fires `onChange` exactly once, which is why the loop re-arms on
    /// every pass. The shape is `AppModel.watchConnection`'s, deliberately: same contract, same
    /// re-arm, same token guard, same weak read so the watcher can never be the reason a store
    /// outlives its activation.
    ///
    /// It waits on an `AsyncStream` that `teardown()` **finishes**, not on a bare
    /// `withCheckedContinuation`. Cancellation cannot resume a checked continuation, and
    /// `SessionStore.stop()` publishes `.idle` only when the state was not already `.idle` — so the
    /// previous shape left this loop suspended forever, holding the model, the reader closure and
    /// an observation registration inside the store: one leak per profile switch and per closed
    /// window. `nil` from the iterator is the exit cancellation alone could never give us.
    /// `DetailModel.beginSessionsWatch` and `AppModel.watchConnection` are the same fix.
    ///
    /// Internal, not private: the unit tests drive it with their own reader, which is the only way
    /// to exercise a reconnect without a server.
    func watchConnection(_ read: @escaping @MainActor () -> ConnectionState?) {
        // Finish *and* cancel the watcher being replaced. Assigning over `connectionWatcher` below
        // only drops the reference; without the finish the old loop stays parked on a stream
        // nothing will ever yield into again.
        connectionSignal?.finish()
        connectionWatcher?.cancel()
        let (changes, signal) = AsyncStream<Void>.makeStream()
        connectionSignal = signal
        connectionWatcherToken &+= 1
        let token = connectionWatcherToken
        isWatchingConnection = true
        connectionWatcher = Task { @MainActor [weak self] in
            // Only the watcher the model still owns may report the loop gone: the predecessor
            // cancelled above unwinds *after* this one armed itself, and an unconditional clear
            // here would publish a false `false` over a live watcher.
            defer {
                if self?.connectionWatcherToken == token { self?.isWatchingConnection = false }
            }
            var iterator = changes.makeAsyncIterator()
            // `nil` until the first pass reads a state, so whatever the connection is at arm time
            // is the baseline and only a LATER arrival at `.live` reconciles. In production that
            // baseline is always `.idle`: `AppModel.activate` calls `makeExtensions(store:)` — and
            // so this initializer — before it calls `store.start()`. So the first real `.live`
            // counts as an entry and re-reads, which is what retries a failed bootstrap.
            var wasLive: Bool?
            while !Task.isCancelled {
                // Read in its own scope: a `self` still bound across the suspension below would
                // make this watcher the reason a dropped model never deinits.
                do {
                    guard let self else { return }
                    // Arming an observation on a store that is gone would park this task on a
                    // signal no write can ever send.
                    guard let state = read() else { return }
                    let isLive = state == .live
                    if isLive, wasLive != true { self.requestRefresh() }
                    wasLive = isLive
                }

                withObservationTracking {
                    _ = read()
                } onChange: {
                    signal.yield()
                }
                // `nil` means the stream was finished — `teardown()`, or a re-arm — which is the
                // one exit cancellation alone could never give us.
                guard await iterator.next() != nil else { return }
                // `onChange` runs just before the property is written, so yield once to let the
                // writer finish before the next pass reads it.
                await Task.yield()
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
