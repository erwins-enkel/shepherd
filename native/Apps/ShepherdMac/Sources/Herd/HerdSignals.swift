import Foundation
import Observation
import ShepherdKit

/// The five herd snapshots, injectable like SidebarReads. No per-row requests or second socket.
struct HerdReads: Sendable {
    var git: @Sendable () async throws -> [String: GitState]
    var activity: @Sendable () async throws -> [String: SessionActivitySignal]
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
final class HerdSignals: AppExtension {
    private(set) var git: [String: GitState] = [:]
    private(set) var activity: [String: SessionActivitySignal] = [:]
    private(set) var claudeAlive: [String: Bool] = [:]
    private(set) var verdicts: [String: ReviewVerdict] = [:]
    private(set) var reviewing: Set<String> = []
    private(set) var reviewerEnv: [String: ReviewerEnv] = [:]
    private(set) var criticActivity: [String: [String]] = [:]

    /// S8 supplies these through the integration lane when its model lands.
    var planRework: @MainActor (Session) -> Bool = { _ in false }
    var planReviewing: @MainActor (Session) -> Bool = { _ in false }

    @ObservationIgnored var reads: HerdReads
    @ObservationIgnored private let now: @Sendable () -> Int
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private let activationGeneration: Int?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var tornDown = false
    @ObservationIgnored private var refreshesInFlight = 0
    @ObservationIgnored private var watcher: Task<Void, Never>?
    @ObservationIgnored private var bootstrap: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshPending = false
    @ObservationIgnored private var connectionWatcher: Task<Void, Never>?
    @ObservationIgnored private var connectionSignal: AsyncStream<Void>.Continuation?
    @ObservationIgnored private var connectionWatcherToken = 0
    @ObservationIgnored private(set) var isWatchingConnection = false

    var isSubscribed: Bool { watcher != nil }
    private var isCurrent: Bool {
        !tornDown && activationGeneration == app?.activationGeneration
    }

    init(store: SessionStore, app: AppModel) {
        self.app = app
        activationGeneration = app.activationGeneration
        reads = .live(store.client)
        now = { Int(Date().timeIntervalSince1970 * 1_000) }
        subscribe(store)
        watchConnection { [weak store] in store?.connection }
        bootstrap = Task { [weak self] in await self?.refresh() }
    }

    init(reads: HerdReads, now: @escaping @Sendable () -> Int) {
        self.reads = reads
        self.now = now
        activationGeneration = nil
    }

    func isReviewing(_ id: String) -> Bool { reviewing.contains(id) }

    /// Raw rollup, matching tab-signal.svelte.ts: a conflict cannot mask a red CI co-signal.
    var ciRed: Set<String> { Set(git.filter { $0.value.checks.known == .failure }.keys) }

    func stage(for session: Session) -> HerdStage {
        HerdClassifier.stageOf(session, git: git[session.id], ctx: HerdContext(
            workingBlocked: app?.extension(SidebarModel.self)?.workingBlocked ?? [:],
            reviewing: isReviewing(session.id) || planReviewing(session),
            verdict: verdicts[session.id], planRework: planRework(session), now: now()))
    }

    /// Same all-or-nothing read and generation fence as SidebarModel. A failed read keeps the
    /// previous maps; the next `.live` transition retries all five, including reviewer identity.
    func refresh() async {
        guard isCurrent else { return }
        let activationSnapshot = app?.activationGeneration
        generation &+= 1
        let mine = generation
        let reads = reads
        refreshesInFlight += 1
        defer { refreshesInFlight -= 1 }
        do {
            async let git = reads.git()
            async let activity = reads.activity()
            async let alive = reads.claudeAlive()
            async let verdicts = reads.verdicts()
            async let inflight = reads.reviewing()
            let loaded = try await (git, activity, alive, verdicts, inflight)
            guard isCurrent, !Task.isCancelled, mine == generation,
                activationSnapshot == app?.activationGeneration else { return }
            self.git = loaded.0
            self.activity = loaded.1
            claudeAlive = loaded.2
            self.verdicts = loaded.3
            reviewing = Set(loaded.4.map(\.id))
            reviewerEnv = loaded.4.reduce(into: [:]) { env, row in
                env[row.id] = ReviewerEnv(provider: row.provider, model: row.model, effort: row.effort)
            }
            // The snapshot has no historical feed. Never carry a prior run across a reconnect.
            criticActivity = [:]
        } catch {
            Log.ui.debug("herd snapshot read failed: \(String(describing: error), privacy: .public)")
        }
    }

    func teardown() {
        tornDown = true
        generation &+= 1
        watcher?.cancel()
        watcher = nil
        connectionWatcher?.cancel()
        connectionWatcher = nil
        connectionSignal?.finish()
        connectionSignal = nil
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
                if case .unknown(let name, let payload) = event, let payload {
                    self.apply(name: name, payload: payload)
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
                git[event.id] = event.git
            case "session:activity":
                let event = try decoder.decode(Components.Schemas.SessionActivityEvent.self, from: payload)
                activity[event.id] = event.activity
            case "session:claude-alive":
                let event = try decoder.decode(Components.Schemas.SessionClaudeAliveEvent.self, from: payload)
                claudeAlive[event.id] = event.claudeAlive
            case "session:review":
                let event = try decoder.decode(Components.Schemas.SessionReviewEvent.self, from: payload)
                verdicts[event.id] = event.review
                // ReviewsStore.apply ends a run for both a landed verdict and its removal.
                applyReviewing(event.id, on: false)
            case "session:reviewing":
                let event = try decoder.decode(Components.Schemas.SessionReviewingEvent.self, from: payload)
                applyReviewing(event.id, on: event.reviewing, env: event.env)
            case "session:critic-activity":
                let event = try decoder.decode(Components.Schemas.SessionCriticActivityEvent.self, from: payload)
                let feed = criticActivity[event.id] ?? []
                if feed.last != event.summary {
                    criticActivity[event.id] = Array((feed + [event.summary]).suffix(2))
                }
            default: return
            }
            // A frame arriving during a snapshot read must not be overwritten by the older read.
            // Apply it now, fence that snapshot, and coalesce one reconciliation. Ordinary frames
            // need no reads at all; only this race retries the potentially incomplete bootstrap.
            if refreshesInFlight > 0 {
                generation &+= 1
                requestRefresh()
            }
        } catch {
            Log.ui.debug("ignoring malformed herd event \(name, privacy: .public)")
        }
    }

    private func applyReviewing(_ id: String, on: Bool, env: ReviewerEnv? = nil) {
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
