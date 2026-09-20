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

    static func live(_ client: ShepherdClient) -> QueuesReads {
        QueuesReads(
            held: { try await client.heldTasks() },
            done: { try await client.doneSessions() },
            recaps: { try await client.recaps() },
            stranded: { try await client.strandedSessions() },
            refreshUpNext: { try await client.refreshUpNext() })
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
    /// Invalidates cached candidates for the NEXT retry presentation. An open dialog must
    /// keep its own selection so a halt frame cannot reselect a row the operator unchecked.
    private(set) var retrySelectionGeneration = 0

    @ObservationIgnored var reads: QueuesReads
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private let activationGeneration: Int?
    // Lifecycle and read ordering are separate: starting a newer read must not end the tap.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var readSequence = 0
    @ObservationIgnored private var isTornDown = false
    @ObservationIgnored private var heldRevision = 0
    @ObservationIgnored private var strandedRevision = 0
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
        activationGeneration = app.activationGeneration
        subscribe(store)
        watchConnection { [weak store] in store?.connection }
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
        let upNextVersion = upNextRevision
        let sources = reads
        async let heldResult = Self.load(sources.held)
        async let doneResult = Self.load(sources.done)
        async let recapsResult = Self.load(sources.recaps)
        async let strandedResult = Self.load(sources.stranded)
        async let upNextResult = Self.load {
            if recomputeUpNext { try await sources.refreshUpNext() }
        }
        let results = await (heldResult, doneResult, recapsResult, strandedResult, upNextResult)
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
            stranded = Set(ids)
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

    private func apply(_ event: ServerEvent) {
        guard case .unknown(let name, let payload) = event, let payload else { return }
        let decoder = JSONDecoder()
        switch name {
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
            guard (try? decoder.decode(Components.Schemas.SessionHaltEvent.self,
                                       from: payload)) != nil else { return }
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
