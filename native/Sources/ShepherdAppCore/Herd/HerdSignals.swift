import Foundation
import Observation
import ShepherdKit

/// The five herd snapshots, injectable like SidebarReads. No per-row requests or second socket.
struct HerdReads: Sendable {
    var git: @Sendable () async throws -> [String: GitState]
    public var activity: @Sendable () async throws -> [String: SessionActivitySignal]
    var claudeAlive: @Sendable () async throws -> [String: Bool]
    var verdicts: @Sendable () async throws -> [String: ReviewVerdict]
    var reviewing: @Sendable () async throws -> [ReviewerInflightEntry]

    static func live(_ client: ShepherdClient) -> HerdReads {
        HerdReads(
            git: { try await client.gitStates() },
            activity: { try await client.activityStates() },
            claudeAlive: { try await client.claudeAliveStates() },
            verdicts: { try await client.reviews() },
            reviewing: { try await client.reviewsInflight() })
    }
}

/// Herd-wide state rebuilt on bootstrap and every reconnect; frames update it immediately.
/// Owns only a SessionStore event tap, never presence or the store's authenticated socket.
@Observable
@MainActor
public final class HerdSignals: AppExtension {
    public private(set) var git: [String: GitState] = [:]
    public private(set) var activity: [String: SessionActivitySignal] = [:]
    private(set) var claudeAlive: [String: Bool] = [:]
    public private(set) var verdicts: [String: ReviewVerdict] = [:]
    private(set) var reviewing: Set<String> = []
    private(set) var reviewerEnv: [String: ReviewerEnv] = [:]
    private(set) var criticActivity: [String: [String]] = [:]

    /// S8 supplies these through the integration lane when its model lands.
    var planRework: @MainActor (Session) -> Bool = { _ in false }
    var planReviewing: @MainActor (Session) -> Bool = { _ in false }

    /// Web: repoConfig.isAutopilotEnabled(repoPath), loaded from
    /// GET /api/repo-config?repo=… → autopilotEnabled. That S12 route/schema is
    /// absent from the native contract; SessionStore.repos is only GET /api/repos
    /// metadata and does not contain this default. The integration lane must bind
    /// S12's observable config here. nil means unavailable, never an inferred false.
    public var repoAutopilotDefault: @MainActor (String) -> Bool? = { _ in nil }

    @ObservationIgnored var reads: HerdReads
    @ObservationIgnored private let now: @Sendable () -> Int
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var store: SessionStore?
    @ObservationIgnored private let activationGeneration: Int?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var tornDown = false
    private enum Snapshot: CaseIterable { case git, activity, alive, verdicts, reviewing }
    private struct ReadState {
        var sequence = 0
        var inFlight = false
        var eventIDs: Set<String> = []
    }
    @ObservationIgnored private var readStates: [Snapshot: ReadState] = [:]
    @ObservationIgnored private var criticIDsWrittenByEvents: Set<String> = []
    @ObservationIgnored private var watcher: Task<Void, Never>?
    @ObservationIgnored private var bootstrap: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshPending = false
    @ObservationIgnored private var connectionWatcher: Task<Void, Never>?
    @ObservationIgnored private var connectionSignal: AsyncStream<Void>.Continuation?
    @ObservationIgnored private var connectionWatcherToken = 0
    @ObservationIgnored private(set) var isWatchingConnection = false
    @ObservationIgnored private var sessionsWatcher: Task<Void, Never>?
    @ObservationIgnored private var sessionsSignal: AsyncStream<Void>.Continuation?
    @ObservationIgnored private var hasLoadedSessionList = false
    @ObservationIgnored private(set) var isWatchingSessions = false

    var isSubscribed: Bool { watcher != nil }
    private var isCurrent: Bool {
        !tornDown && activationGeneration == app?.activationGeneration
    }

    public init(store: SessionStore, app: AppModel) {
        self.app = app
        self.store = store
        activationGeneration = app.activationGeneration
        reads = .live(store.client)
        now = { Int(Date().timeIntervalSince1970 * 1_000) }
        subscribe(store)
        watchSessions()
        watchConnection { [weak store] in store?.connection }
        bootstrap = Task { [weak self] in await self?.refresh() }
    }

    init(reads: HerdReads, now: @escaping @Sendable () -> Int) {
        self.reads = reads
        self.now = now
        activationGeneration = nil
    }

    public func isReviewing(_ id: String) -> Bool { reviewing.contains(id) }

    /// Raw rollup, matching tab-signal.svelte.ts: a conflict cannot mask a red CI co-signal.
    var ciRed: Set<String> { Set(git.filter { $0.value.checks.known == .failure }.keys) }

    func stage(for session: Session) -> HerdStage {
        HerdClassifier.stageOf(session, git: git[session.id], ctx: HerdContext(
            workingBlocked: app?.extension(SidebarModel.self)?.workingBlocked ?? [:],
            reviewing: isReviewing(session.id) || planReviewing(session),
            verdict: verdicts[session.id], planRework: planRework(session), now: now()))
    }

    /// Each map installs independently. Events received during its read overlay that snapshot,
    /// including removals, so busy sessions cannot prevent quiet sessions from bootstrapping.
    func refresh() async {
        guard isCurrent else { return }
        // Reserve every read before yielding: a frame between refresh() and a child task's
        // first turn must already count as an overlay for that captured set of reads.
        var sequences: [Snapshot: Int] = [:]
        for map in Snapshot.allCases {
            readStates[map, default: ReadState()].sequence &+= 1
            sequences[map] = readStates[map]?.sequence
            readStates[map]?.inFlight = true
            readStates[map]?.eventIDs.removeAll()
        }
        criticIDsWrittenByEvents.removeAll()
        let reads = reads
        async let git: Void = readSnapshot(.git, sequence: sequences[.git]!, read: reads.git) { loaded, ids in
            self.git = Self.overlay(loaded, with: self.git, ids: ids)
        }
        async let activity: Void = readSnapshot(.activity, sequence: sequences[.activity]!, read: reads.activity) { loaded, ids in
            self.activity = Self.overlay(loaded, with: self.activity, ids: ids)
        }
        async let alive: Void = readSnapshot(.alive, sequence: sequences[.alive]!, read: reads.claudeAlive) { loaded, ids in
            self.claudeAlive = Self.overlay(loaded, with: self.claudeAlive, ids: ids)
        }
        async let verdicts: Void = readSnapshot(.verdicts, sequence: sequences[.verdicts]!, read: reads.verdicts) { loaded, ids in
            self.verdicts = Self.overlay(loaded, with: self.verdicts, ids: ids)
        }
        async let reviewing: Void = readSnapshot(.reviewing, sequence: sequences[.reviewing]!, read: reads.reviewing) { loaded, ids in
            var reviewing = Set(loaded.map(\.id))
            var env = loaded.reduce(into: [String: ReviewerEnv]()) { env, row in
                env[row.id] = ReviewerEnv(provider: row.provider, model: row.model, effort: row.effort)
            }
            for id in ids {
                if self.reviewing.contains(id) { reviewing.insert(id) } else { reviewing.remove(id) }
                env[id] = self.reviewerEnv[id]
            }
            self.reviewing = reviewing
            self.reviewerEnv = env
            // There is no historical feed in the snapshot. Preserve only mid-read activity.
            self.criticActivity = self.criticActivity.filter { self.criticIDsWrittenByEvents.contains($0.key) }
        }
        _ = await (git, activity, alive, verdicts, reviewing)
    }

    private func readSnapshot<Value: Sendable>(
        _ map: Snapshot, sequence: Int, read: @Sendable () async throws -> Value,
        install: @MainActor (Value, Set<String>) -> Void
    ) async {
        guard isCurrent, sequence == readStates[map]?.sequence else { return }
        let mine = generation
        let activationSnapshot = app?.activationGeneration
        defer {
            if readStates[map]?.sequence == sequence {
                readStates[map]?.inFlight = false
                readStates[map]?.eventIDs.removeAll()
                if map == .reviewing { criticIDsWrittenByEvents.removeAll() }
            }
        }
        do {
            let loaded = try await read()
            guard isCurrent, !Task.isCancelled, mine == generation,
                sequence == readStates[map]?.sequence,
                activationSnapshot == app?.activationGeneration else { return }
            install(loaded, readStates[map]?.eventIDs ?? [])
            if let ids = liveSessionIDs() { prune(to: ids) }
        } catch {
            Log.ui.debug("herd snapshot read failed: \(String(describing: error), privacy: .public)")
        }
    }

    private static func overlay<Value>(
        _ loaded: [String: Value], with current: [String: Value], ids: Set<String>
    ) -> [String: Value] {
        var result = loaded
        for id in ids { result[id] = current[id] }
        return result
    }

    private func recordEvent(_ id: String, in map: Snapshot) {
        if readStates[map]?.inFlight == true { readStates[map]?.eventIDs.insert(id) }
    }

    private func archive(_ id: String) {
        for map in Snapshot.allCases { recordEvent(id, in: map) }
        git[id] = nil
        activity[id] = nil
        claudeAlive[id] = nil
        verdicts[id] = nil
        reviewing.remove(id)
        reviewerEnv[id] = nil
        criticActivity[id] = nil
    }

    func prune(to live: Set<String>) {
        let known = Set(git.keys).union(activity.keys).union(claudeAlive.keys)
            .union(verdicts.keys).union(reviewing).union(reviewerEnv.keys).union(criticActivity.keys)
        // Reconciliation removals are overlays too: a slower map cannot resurrect them.
        for id in known.subtracting(live) { archive(id) }
    }

    /// settings is installed with the initial sessions snapshot. Before that, an empty list
    /// is unknown; afterwards (or after observing sessions), empty is authoritative too.
    private func liveSessionIDs() -> Set<String>? {
        guard let store else { return nil }
        if store.settings != nil || !store.sessions.isEmpty { hasLoadedSessionList = true }
        guard hasLoadedSessionList else { return nil }
        return Set(store.sessions.filter { $0.status.known != .archived }.map(\.id))
    }

    /// The session list can reconcile after our snapshots, including when every herd read
    /// fails. Observe it independently so a missed archive never requires a successful read.
    private func watchSessions() {
        let (changes, signal) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        sessionsSignal = signal
        isWatchingSessions = true
        sessionsWatcher = Task { @MainActor [weak self] in
            defer { self?.isWatchingSessions = false }
            var iterator = changes.makeAsyncIterator()
            while !Task.isCancelled {
                do {
                    guard let self, self.isCurrent else { return }
                    let ids = withObservationTracking {
                        self.liveSessionIDs()
                    } onChange: {
                        signal.yield()
                    }
                    if let ids { self.prune(to: ids) }
                }
                // Release self before parking, and sample after Observation's willSet edge.
                guard await iterator.next() != nil else { return }
                await Task.yield()
            }
        }
    }

    public func teardown() {
        tornDown = true
        store = nil
        generation &+= 1
        watcher?.cancel()
        watcher = nil
        connectionWatcher?.cancel()
        connectionWatcher = nil
        connectionSignal?.finish()
        connectionSignal = nil
        sessionsSignal?.finish()
        sessionsSignal = nil
        sessionsWatcher?.cancel()
        sessionsWatcher = nil
        bootstrap?.cancel()
        bootstrap = nil
        refreshTask?.cancel()
        refreshTask = nil
        refreshPending = false
    }

    private func subscribe(_ store: SessionStore) {
        let frames = store.events()
        let activationSnapshot = app?.activationGeneration
        watcher = Task { @MainActor [weak self] in
            for await event in frames {
                // Cancelled streams still yield buffered frames. The lifecycle fence is required
                // even though teardown also cancels this task and unregisters the tap.
                guard let self, self.isCurrent, !Task.isCancelled,
                    activationSnapshot == self.app?.activationGeneration else { return }
                switch event {
                case .sessionArchived(let payload): self.archive(payload.id)
                case .unknown(let name, let payload):
                    if let payload { self.apply(name: name, payload: payload) }
                default: break
                }
            }
        }
    }

    /// Every payload type comes from the contract, including S2's git/activity event schemas.
    private func apply(name: String, payload: Data) {
        guard isCurrent else { return }
        let decoder = JSONDecoder()
        do {
            switch name {
            case "session:git":
                let event = try decoder.decode(Components.Schemas.SessionGitEvent.self, from: payload)
                recordEvent(event.id, in: .git)
                git[event.id] = event.git
            case "session:activity":
                let event = try decoder.decode(Components.Schemas.SessionActivityEvent.self, from: payload)
                recordEvent(event.id, in: .activity)
                activity[event.id] = event.activity
            case "session:claude-alive":
                let event = try decoder.decode(Components.Schemas.SessionClaudeAliveEvent.self, from: payload)
                recordEvent(event.id, in: .alive)
                claudeAlive[event.id] = event.claudeAlive
            case "session:review":
                let event = try decoder.decode(Components.Schemas.SessionReviewEvent.self, from: payload)
                recordEvent(event.id, in: .verdicts)
                verdicts[event.id] = event.review
                // ReviewsStore.apply ends a run for both a landed verdict and its removal.
                applyReviewing(event.id, on: false)
            case "session:reviewing":
                let event = try decoder.decode(Components.Schemas.SessionReviewingEvent.self, from: payload)
                applyReviewing(event.id, on: event.reviewing, env: event.env)
            case "session:critic-activity":
                let event = try decoder.decode(Components.Schemas.SessionCriticActivityEvent.self, from: payload)
                if readStates[.reviewing]?.inFlight == true { criticIDsWrittenByEvents.insert(event.id) }
                let feed = criticActivity[event.id] ?? []
                if feed.last != event.summary {
                    criticActivity[event.id] = Array((feed + [event.summary]).suffix(2))
                }
            default: return
            }
            // A late producer frame for an already-removed id must not repopulate the maps.
            if let ids = liveSessionIDs() { prune(to: ids) }
        } catch {
            Log.ui.debug("ignoring malformed herd event \(name, privacy: .public)")
        }
    }

    private func applyReviewing(_ id: String, on: Bool, env: ReviewerEnv? = nil) {
        recordEvent(id, in: .reviewing)
        // Identity is written BEFORE the transition guard: repeated true can change the CLI.
        if on {
            if let env { reviewerEnv[id] = env }
        } else {
            reviewerEnv[id] = nil
        }
        guard isReviewing(id) != on else { return }
        criticActivity[id] = nil
        if on { reviewing.insert(id) } else { reviewing.remove(id) }
    }

    /// SidebarModel's observation/AsyncStream loop, with the same replacement token guard.
    /// Finishing the signal in teardown wakes a parked loop even if connection never changes.
    func watchConnection(_ read: @escaping @MainActor () -> ConnectionState?) {
        guard isCurrent else { return }
        connectionSignal?.finish()
        connectionWatcher?.cancel()
        let (changes, signal) = AsyncStream<Void>.makeStream()
        connectionSignal = signal
        connectionWatcherToken &+= 1
        let token = connectionWatcherToken
        let activationSnapshot = app?.activationGeneration
        isWatchingConnection = true
        connectionWatcher = Task { @MainActor [weak self] in
            defer {
                if self?.connectionWatcherToken == token { self?.isWatchingConnection = false }
            }
            var iterator = changes.makeAsyncIterator()
            var wasLive: Bool?
            while !Task.isCancelled {
                do {
                    guard let self, self.isCurrent,
                        activationSnapshot == self.app?.activationGeneration,
                        let state = read() else { return }
                    let isLive = state == .live
                    if isLive, wasLive != true { self.requestRefresh() }
                    wasLive = isLive
                }
                withObservationTracking {
                    _ = read()
                } onChange: {
                    signal.yield()
                }
                guard await iterator.next() != nil else { return }
                await Task.yield()
            }
        }
    }

    /// A burst during an outstanding reconciliation becomes one additional read, not N reads.
    private func requestRefresh() {
        guard isCurrent else { return }
        guard refreshTask == nil else {
            refreshPending = true
            return
        }
        refreshTask = Task { [weak self] in
            guard let self else { return }
            await self.refresh()
            while self.refreshPending, self.isCurrent, !Task.isCancelled {
                self.refreshPending = false
                await self.refresh()
            }
            self.refreshTask = nil
        }
    }

    #if DEBUG
        func applyForTesting(name: String, payload: [String: Any]) {
            guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
            apply(name: name, payload: data)
        }
    #endif
}

#if DEBUG
    extension HerdReads {
        static func stub(
            git: [String: GitState] = [:],
            activity: [String: SessionActivitySignal] = [:],
            claudeAlive: [String: Bool] = [:],
            verdicts: [String: ReviewVerdict] = [:],
            reviewing: [ReviewerInflightEntry] = []
        ) -> HerdReads {
            HerdReads(git: { git }, activity: { activity }, claudeAlive: { claudeAlive },
                verdicts: { verdicts }, reviewing: { reviewing })
        }
    }
#endif
