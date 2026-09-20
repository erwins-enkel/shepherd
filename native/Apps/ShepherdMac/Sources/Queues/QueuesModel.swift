import Foundation
import Observation
import ShepherdKit

/// Queue snapshots and the fire-and-forget Up Next computation. The latter delivers its
/// result through upnext:snapshot; a successful POST is not a snapshot or an empty list.
struct QueuesReads: Sendable {
    var held: @Sendable () async throws -> [HeldQueueEntry]
    var done: @Sendable () async throws -> [Session]
    var recaps: @Sendable () async throws -> [String: Recap]
    var stranded: @Sendable () async throws -> [String]
    var refreshUpNext: @Sendable () async throws -> Void
    // Optional for previews/tests without a session snapshot source.
    var haltSnapshots: @Sendable () async throws -> [Session]? = { nil }

    static func live(_ client: ShepherdClient) -> QueuesReads {
        QueuesReads(
            held: { try await client.heldTasks() },
            done: { try await client.doneSessions() },
            recaps: { try await client.recaps() },
            stranded: { try await client.strandedSessions() },
            refreshUpNext: { try await client.refreshUpNext() },
            haltSnapshots: { try await client.sessions() })
    }
}

/// Per-activation queue state. The store owns sessions and the socket; this extension owns
/// one event tap and reconciles its snapshots on bootstrap and every connection to `.live`.
@Observable
@MainActor
final class QueuesModel: AppExtension {
    private(set) var held: [HeldQueueEntry] = []
    private(set) var heldCount = 0
    private(set) var upNext: UpNextSnapshot?
    private(set) var upNextLoadFailed = false
    private(set) var done: [Session] = []
    private(set) var recaps: [String: Recap] = [:]
    private(set) var stranded: Set<String> = []

    /// Independent notice slots: an auto-revive outcome must never replace the actionable
    /// stranded notice. Rendering and dismissal belong to the queue actions UI.
    private(set) var strandedNotice: Components.Schemas.SessionsStrandedEvent?
    private(set) var autoRevivedNotice: Components.Schemas.AutoRevivedEvent?
    private(set) var haltDoneNotice: HaltResult?
    /// Invalidates cached candidates for the NEXT retry presentation. An open dialog must
    /// keep its own selection so a halt frame cannot reselect a row the operator unchecked.
    private(set) var retrySelectionGeneration = 0
    private var haltFlags: [String: Components.Schemas.SessionHaltEvent] = [:]

    /// Overlay reconciled halt flags when opening Retry and rendering badges. SessionStore
    /// also patches pushes; this overlay repairs missed frames from the queue's REST refresh.
    /// The sheet owns its selection throughout.
    var retrySessions: [Session] {
        (store?.sessions ?? []).map { session in
            guard let flags = haltFlags[session.id] else { return session }
            var current = session
            current.haltReason = flags.haltReason.map {
                .init(value1: .init(rawValue: $0.rawValue), value2: $0.rawValue)
            }
            current.haltedAt = flags.haltedAt
            return current
        }
    }

    @ObservationIgnored var reads: QueuesReads
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var store: SessionStore?
    @ObservationIgnored private let activationGeneration: Int?
    // Lifecycle and read ordering are separate: starting a newer read must not end the tap.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var readSequence = 0
    @ObservationIgnored private var isTornDown = false
    @ObservationIgnored private var heldRevision = 0
    @ObservationIgnored private var strandedRevision = 0
    @ObservationIgnored private var archivedStrandedIDs: Set<String> = []
    @ObservationIgnored private var hasSessionList = false
    @ObservationIgnored private var upNextRevision = 0
    @ObservationIgnored private var watcher: Task<Void, Never>?
    @ObservationIgnored private var connectionWatcher: Task<Void, Never>?
    @ObservationIgnored private var connectionSignal: AsyncStream<Void>.Continuation?
    @ObservationIgnored private var connectionWatcherToken = 0
    @ObservationIgnored private(set) var isWatchingConnection = false
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshPending = false
    @ObservationIgnored private var upNextRefreshPending = false

    var isSubscribed: Bool { watcher != nil }
    /// Whether the bootstrap/event/reconnect reconciliation loop is active.
    var isRefreshing: Bool { refreshTask != nil }

    init(store: SessionStore, app: AppModel) {
        reads = .live(store.client)
        self.app = app
        self.store = store
        activationGeneration = app.activationGeneration
        subscribe(store)
        watchConnection { [weak store] in
            // The same finished observation stream also reconciles a newly installed session
            // snapshot, even when no archive frame survived a disconnect.
            _ = store?.sessions
            _ = store?.settings
            return store?.connection
        }
        // Bootstrap shares the coalescing loop with events, including late registration
        // against an already-live store. There is no second bootstrap task to race it.
        requestRefresh(recomputeUpNext: true)
    }

    /// Test/preview seam: no app, socket or automatic bootstrap.
    init(reads: QueuesReads) {
        self.reads = reads
        activationGeneration = nil
    }

    private func isCurrent(_ mine: Int) -> Bool {
        !isTornDown && generation == mine && activationGeneration == app?.activationGeneration
    }

    /// Failures preserve the affected snapshot without discarding successful independent
    /// reads. Reconnect retries all snapshots; Up Next failure has its own visible state.
    func refresh(recomputeUpNext: Bool = true) async {
        let mine = generation
        guard isCurrent(mine) else { return }
        let activation = app?.activationGeneration
        readSequence &+= 1
        let sequence = readSequence
        let heldVersion = heldRevision
        let strandedVersion = strandedRevision
        let haltVersion = retrySelectionGeneration
        let upNextVersion = upNextRevision
        let sources = reads
        let mayRecompute = app?.allowsQueueRecomputation ?? true
        async let heldResult = Self.load(sources.held)
        async let doneResult = Self.load(sources.done)
        async let recapsResult = Self.load(sources.recaps)
        async let strandedResult = Self.load(sources.stranded)
        async let haltResult = Self.load(sources.haltSnapshots)
        async let upNextResult = Self.load {
            if recomputeUpNext && mayRecompute { try await sources.refreshUpNext() }
        }
        let results = await (heldResult, doneResult, recapsResult, strandedResult, upNextResult, haltResult)
        guard isCurrent(mine), activation == app?.activationGeneration,
              sequence == readSequence, !Task.isCancelled else { return }

        // A count frame is newer than a read already in flight. Its queued follow-up will
        // supply the list; until then keep the badge rather than restoring an older count.
        if case .success(let rows) = results.0, heldVersion == heldRevision {
            held = rows
            heldCount = rows.count
        }
        if case .success(let rows) = results.1 { done = rows }
        if case .success(let map) = results.2 { recaps = map }
        if case .success(let ids) = results.3, strandedVersion == strandedRevision {
            reconcileStranded(ids)
        }
        pruneStranded()
        // Reconnect repairs missed halt frames; a frame received during this read wins.
        if case .success(let sessions?) = results.5, haltVersion == retrySelectionGeneration {
            haltFlags = Dictionary(uniqueKeysWithValues: sessions.map { session in
                (session.id, .init(id: session.id,
                    haltReason: session.haltReason.map {
                        .init(value1: .init(rawValue: $0.rawValue), value2: $0.rawValue)
                    },
                    haltedAt: session.haltedAt))
            })
        }
        if recomputeUpNext, upNextVersion == upNextRevision {
            switch results.4 {
            case .success: upNextLoadFailed = false
            case .failure: upNextLoadFailed = true
            }
        }
    }

    /// User commands need a throwing, held-only reconciliation so read failures reach the
    /// existing SessionCommandState gate. Revision fences also cover the background loop.
    func reloadHeld() async throws {
        let mine = generation
        guard isCurrent(mine), !Task.isCancelled else { return }
        heldRevision &+= 1
        let version = heldRevision
        let rows = try await reads.held()
        guard isCurrent(mine), version == heldRevision, !Task.isCancelled else { return }
        heldRevision &+= 1
        held = rows
        heldCount = rows.count
    }

    /// Reconcile a revive command without allowing an older background read to restore its IDs.
    func reloadStranded() async throws {
        let mine = generation
        guard isCurrent(mine), !Task.isCancelled else { return }
        strandedRevision &+= 1
        let version = strandedRevision
        let ids = try await reads.stranded()
        guard isCurrent(mine), version == strandedRevision, !Task.isCancelled else { return }
        strandedRevision &+= 1
        reconcileStranded(ids)
        pruneStranded()
    }

    private nonisolated static func load<Value: Sendable>(
        _ read: @Sendable () async throws -> Value
    ) async -> Result<Value, any Error> {
        do { return .success(try await read()) }
        catch {
            Log.ui.debug("queues snapshot read failed: \(String(describing: error), privacy: .public)")
            return .failure(error)
        }
    }

    func teardown() {
        store = nil
        isTornDown = true
        generation &+= 1
        watcher?.cancel()
        watcher = nil
        connectionWatcher?.cancel()
        connectionWatcher = nil
        connectionSignal?.finish()
        connectionSignal = nil
        refreshTask?.cancel()
        refreshTask = nil
        refreshPending = false
        upNextRefreshPending = false
    }

    /// The HTTP result and its socket echo share one slot, including remote operators' halts.
    func recordHaltDone(_ result: HaltResult) {
        guard isCurrent(generation), !Task.isCancelled else { return }
        haltDoneNotice = result
    }

    func dismissHaltDone() { haltDoneNotice = nil }
    func dismissAutoRevived() { autoRevivedNotice = nil }

    private func subscribe(_ store: SessionStore) {
        let frames = store.events()
        let mine = generation
        let activation = app?.activationGeneration
        watcher = Task { @MainActor [weak self] in
            for await event in frames {
                // Cancellation does not discard buffered frames. Fence them with BOTH the
                // model lifetime and app activation before any event can change state.
                guard let self, self.isCurrent(mine),
                      activation == self.app?.activationGeneration, !Task.isCancelled else { return }
                self.apply(event)
            }
        }
    }

    private func reconcileStranded(_ ids: [String]) {
        let snapshot = Set(ids)
        // Archiving updates sessions before the server poller cleans up stranded IDs.
        // Only a successful, revision-fenced read confirming absence releases a tombstone.
        archivedStrandedIDs.formIntersection(snapshot)
        stranded = snapshot.subtracting(archivedStrandedIDs)
    }

    private func pruneStranded() {
        guard let store else { return }
        // Settings and sessions are installed together by SessionStore.refresh(). Settings
        // therefore distinguish an empty bootstrap snapshot from the initial empty property.
        // Remember event-populated lists too, including after their last session is archived.
        hasSessionList = hasSessionList || store.settings != nil || !store.sessions.isEmpty
        guard hasSessionList else { return }
        // Held tasks and Up Next issues have different identities from sessions.
        stranded.formIntersection(store.sessions.map(\.id))
    }

    private func apply(_ event: ServerEvent) {
        if case .sessionNew = event { hasSessionList = true }
        if case .sessionArchived(let frame) = event {
            haltFlags[frame.id] = nil
            retrySelectionGeneration &+= 1
            archivedStrandedIDs.insert(frame.id)
            stranded.remove(frame.id)
            strandedRevision &+= 1
            requestRefresh()
            return
        }
        guard case .unknown(let name, let payload) = event, let payload else { return }
        let decoder = JSONDecoder()
        switch name {
        case "halt:done":
            guard let frame = try? decoder.decode(Components.Schemas.HaltDoneEvent.self,
                                                  from: payload) else { return }
            recordHaltDone(frame)
        case "session:claude-alive":
            // The liveness schema belongs to S7. Treat the frame as an invalidation only;
            // GET /api/stranded is the authoritative generated payload for this stream.
            strandedRevision &+= 1
            requestRefresh()
        case "held:changed":
            guard let frame = try? decoder.decode(Components.Schemas.HeldChangedEvent.self,
                                                  from: payload) else { return }
            heldRevision &+= 1
            heldCount = frame.count
            requestRefresh()
        case "upnext:snapshot":
            guard let frame = try? decoder.decode(Components.Schemas.UpNextSnapshotEvent.self,
                                                  from: payload) else { return }
            upNextRevision &+= 1
            upNext = frame.snapshot
            upNextLoadFailed = false
        case "session:halt":
            guard let frame = try? decoder.decode(Components.Schemas.SessionHaltEvent.self,
                                                  from: payload) else { return }
            // Keep null flags as an explicit clear, rather than falling back to a stale store.
            haltFlags[frame.id] = frame
            retrySelectionGeneration &+= 1
        case "app:sessions-stranded":
            guard let frame = try? decoder.decode(Components.Schemas.SessionsStrandedEvent.self,
                                                  from: payload) else { return }
            strandedNotice = frame
            strandedRevision &+= 1
            requestRefresh()
        case "app:auto-revived":
            guard let frame = try? decoder.decode(Components.Schemas.AutoRevivedEvent.self,
                                                  from: payload) else { return }
            autoRevivedNotice = frame
            strandedRevision &+= 1
            requestRefresh()
        default:
            break
        }
    }

    /// Observation wakes an AsyncStream, which teardown and replacement explicitly finish.
    /// No task holds the model across the idle wait; an obsolete watcher cannot clear the
    /// replacement's liveness flag or reconcile an outgoing activation.
    func watchConnection(_ read: @escaping @MainActor () -> ConnectionState?) {
        guard isCurrent(generation) else { return }
        connectionSignal?.finish()
        connectionWatcher?.cancel()
        let (changes, signal) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        connectionSignal = signal
        connectionWatcherToken &+= 1
        let token = connectionWatcherToken
        let mine = generation
        let activation = app?.activationGeneration
        isWatchingConnection = true
        connectionWatcher = Task { @MainActor [weak self] in
            defer {
                if self?.connectionWatcherToken == token { self?.isWatchingConnection = false }
            }
            var iterator = changes.makeAsyncIterator()
            var wasLive: Bool?
            while !Task.isCancelled {
                do {
                    guard let self, self.isCurrent(mine),
                          activation == self.app?.activationGeneration,
                          self.connectionWatcherToken == token, let state = read() else { return }
                    self.pruneStranded()
                    let isLive = state == .live
                    if isLive, wasLive != true { self.requestRefresh(recomputeUpNext: true) }
                    wasLive = isLive
                }
                withObservationTracking { _ = read() } onChange: { signal.yield() }
                guard await iterator.next() != nil else { return }
                // Observation fires before the property's write finishes.
                await Task.yield()
            }
        }
    }

    /// Event bursts collapse into one follow-up read. A reconnect also remembers that
    /// Up Next needs recomputing; ordinary held/stranded frames never start that computation.
    private func requestRefresh(recomputeUpNext: Bool = false) {
        let mine = generation
        guard isCurrent(mine) else { return }
        refreshPending = true
        upNextRefreshPending = upNextRefreshPending || recomputeUpNext
        guard refreshTask == nil else { return }
        refreshTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.generation == mine { self.refreshTask = nil }
            }
            while self.refreshPending, self.isCurrent(mine), !Task.isCancelled {
                let compute = self.upNextRefreshPending
                self.refreshPending = false
                self.upNextRefreshPending = false
                await self.refresh(recomputeUpNext: compute)
            }
        }
    }
}
