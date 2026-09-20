import Foundation
import Observation
import ShepherdKit

/// The two authoritative snapshots; injected reads keep model tests off the network.
struct PlanReads: Sendable {
    var gates: @Sendable () async throws -> [String: PlanGate]
    var inflight: @Sendable () async throws -> [PlanGateInflightEntry]

    static func live(_ client: ShepherdClient) -> PlanReads {
        PlanReads(
            gates: { try await client.planGates() },
            inflight: { try await client.planGatesInflight() })
    }
}

/// Per-activation plan state. SessionStore remains the sole owner of Session and its phase.
/// Snapshots reconcile after reconnects; event changes invalidate older in-flight snapshots.
@Observable
@MainActor
final class PlanModel: AppExtension {
    private static let MAX_ACTIVITY_LINES = 2
    private(set) var gates: [String: PlanGate] = [:]
    private(set) var reviewing: Set<String> = []
    private(set) var reviewerEnv: [String: ReviewerEnv] = [:]
    private(set) var activity: [String: [String]] = [:]
    private(set) var openPlanTick: [String: Int] = [:]
    /// Suppresses a repeated /go until the phase event arrives. The integration lane will
    /// eventually teach SessionStore to apply that phase; we never patch its sessions here.
    private(set) var releasedGates: Set<String> = []

    @ObservationIgnored var reads: PlanReads
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var activation: Int?
    @ObservationIgnored private var generation = 0
    /// Unlike snapshot generation, this stays stable across refreshes and event mutations.
    @ObservationIgnored private var lifecycle = 0
    @ObservationIgnored private var tornDown = false
    @ObservationIgnored private var activeRefreshes = 0
    @ObservationIgnored private var watcher: Task<Void, Never>?
    @ObservationIgnored private var connectionWatcher: Task<Void, Never>?
    @ObservationIgnored private var connectionSignal: AsyncStream<Void>.Continuation?
    @ObservationIgnored private var connectionWatcherToken = 0
    @ObservationIgnored private(set) var isWatchingConnection = false
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshPending = false

    var isSubscribed: Bool { watcher != nil }
    private var isActive: Bool { !tornDown && activation == app?.activationGeneration }

    init(store: SessionStore, app: AppModel) {
        self.app = app
        activation = app.activationGeneration
        reads = .live(store.client)
        subscribe(store)
        watchConnection { [weak store] in store?.connection }
        // Bootstrap uses the same collapsing queue as reconnects, including late registration.
        requestRefresh()
    }

    init(reads: PlanReads) {
        self.reads = reads
    }

    func questionsUnanswered(_ id: String) -> Bool {
        PlanGateChip.questionsUnanswered(gates[id])
    }

    func canRelease(_ session: Session) -> Bool {
        !releasedGates.contains(session.id)
            && PlanGateChip.canRelease(session: session, gate: gates[session.id])
    }

    /// Called by the action owner only after /go returns true.
    func markReleased(_ id: String) {
        guard isActive else { return }
        releasedGates.insert(id)
    }

    func openPlan(_ id: String) {
        guard isActive else { return }
        openPlanTick[id, default: 0] += 1
    }

    /// All-or-nothing reconciliation, like SidebarModel: a failed read preserves the last state.
    func refresh() async {
        guard isActive, !Task.isCancelled else { return }
        let activationSnapshot = app?.activationGeneration
        generation &+= 1
        let mine = generation
        activeRefreshes += 1
        defer { activeRefreshes -= 1 }
        do {
            async let loadedGates = reads.gates()
            async let inflight = reads.inflight()
            let loaded = try await (loadedGates, inflight)
            guard isActive, !Task.isCancelled, mine == generation,
                  activationSnapshot == app?.activationGeneration else { return }
            // Injected reads have the same validation boundary as the live client.
            for gate in loaded.0.values { try gate.validateVisualBlocks() }
            gates = loaded.0
            reviewing = Set(loaded.1.map(\.id))
            reviewerEnv = loaded.1.reduce(into: [:]) { result, entry in
                result[entry.id] = ReviewerEnv(
                    provider: entry.provider.map {
                        ReviewerProvider(value1: ReviewerProviderKnown(rawValue: $0.rawValue), value2: $0.rawValue)
                    }, model: entry.model, effort: entry.effort)
            }
            activity = [:]
        } catch {
            guard isActive, mine == generation,
                  activationSnapshot == app?.activationGeneration else { return }
            Log.ui.debug("plan snapshot read failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// Coalesce a burst into one trailing read. Event taps never await network work.
    func requestRefresh() {
        guard isActive else { return }
        guard refreshTask == nil else {
            refreshPending = true
            return
        }
        let token = lifecycle
        let activationSnapshot = app?.activationGeneration
        refreshTask = Task { [weak self] in
            guard let self else { return }
            repeat {
                guard self.isActive, self.lifecycle == token, !Task.isCancelled,
                      activationSnapshot == self.app?.activationGeneration else { return }
                self.refreshPending = false
                await self.refresh()
            } while self.refreshPending
            guard self.lifecycle == token,
                  activationSnapshot == self.app?.activationGeneration else { return }
            self.refreshTask = nil
        }
    }

    private func subscribe(_ store: SessionStore) {
        let frames = store.events()
        let token = lifecycle
        let activationSnapshot = app?.activationGeneration
        watcher = Task { [weak self] in
            for await event in frames {
                guard let self, self.isActive, self.lifecycle == token, !Task.isCancelled,
                      activationSnapshot == self.app?.activationGeneration else { return }
                self.receive(event)
            }
        }
    }

    /// Decode only our generated schemas. A malformed frame cannot partially install a gate.
    func receive(_ event: ServerEvent) {
        guard isActive else { return }
        do {
            switch event {
            case .unknown(let name, let payload):
                guard let payload else { return }
                switch name {
                case "session:plangate":
                    let frame = try JSONDecoder().decode(SessionPlanGateEvent.self, from: payload)
                    try frame.gate?.validateVisualBlocks()
                    guard frame.gate != nil || frame.planPhase != nil else { return }
                    invalidateSnapshot()
                    if let gate = frame.gate {
                        gates[frame.id] = gate
                        applyReviewing(frame.id, false)
                    }
                    if frame.planPhase != nil { releasedGates.remove(frame.id) }
                case "session:plangate-reviewing":
                    let frame = try JSONDecoder().decode(SessionPlanGateReviewingEvent.self, from: payload)
                    invalidateSnapshot()
                    applyReviewing(frame.id, frame.reviewing, env: frame.env)
                case "session:plangate-activity":
                    let frame = try JSONDecoder().decode(SessionPlanGateActivityEvent.self, from: payload)
                    // Activity is absent from snapshots; do not restart HTTP reads for each line.
                    var feed = activity[frame.id] ?? []
                    guard feed.last != frame.summary else { return }
                    feed.append(frame.summary)
                    activity[frame.id] = Array(feed.suffix(Self.MAX_ACTIVITY_LINES))
                default: return
                }
            case .sessionArchived(let frame):
                invalidateSnapshot()
                gates[frame.id] = nil
                applyReviewing(frame.id, false)
                activity[frame.id] = nil
                releasedGates.remove(frame.id)
                // Keep the tick monotonic for the lifetime of this activation.
            default: return
            }
        } catch {
            Log.ui.debug("ignoring malformed plan event: \(String(describing: error), privacy: .public)")
        }
    }

    private func invalidateSnapshot() {
        generation &+= 1
        if activeRefreshes > 0 { requestRefresh() }
    }

    private func applyReviewing(_ id: String, _ on: Bool, env: ReviewerEnv? = nil) {
        // Identity refresh precedes the transition guard, including redundant starts.
        if on {
            if let env { reviewerEnv[id] = env }
        } else {
            reviewerEnv[id] = nil
        }
        guard reviewing.contains(id) != on else { return }
        activity[id] = nil
        if on { reviewing.insert(id) } else { reviewing.remove(id) }
    }

    /// Observation wakes a finishable stream, never a bare continuation. Re-arming gives the
    /// replacement sole ownership of the watcher flag, even while the old task unwinds.
    func watchConnection(_ read: @escaping @MainActor () -> ConnectionState?) {
        guard isActive else { return }
        connectionSignal?.finish()
        connectionWatcher?.cancel()
        let (changes, signal) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        connectionSignal = signal
        connectionWatcherToken &+= 1
        let token = connectionWatcherToken
        let life = lifecycle
        let activationSnapshot = app?.activationGeneration
        isWatchingConnection = true
        connectionWatcher = Task { [weak self] in
            defer {
                if self?.connectionWatcherToken == token { self?.isWatchingConnection = false }
            }
            var iterator = changes.makeAsyncIterator()
            var wasLive = false
            while !Task.isCancelled {
                do {
                    guard let self, self.isActive, self.lifecycle == life,
                          self.connectionWatcherToken == token,
                          activationSnapshot == self.app?.activationGeneration else { return }
                    let state = withObservationTracking {
                        read()
                    } onChange: {
                        signal.yield()
                    }
                    guard let state else { return }
                    let live = state == .live
                    if live && !wasLive { self.requestRefresh() }
                    wasLive = live
                }
                guard await iterator.next() != nil else { return }
                await Task.yield()
            }
        }
    }

    func teardown() {
        tornDown = true
        lifecycle &+= 1
        generation &+= 1
        watcher?.cancel()
        watcher = nil
        connectionSignal?.finish()
        connectionSignal = nil
        connectionWatcher?.cancel()
        connectionWatcher = nil
        refreshTask?.cancel()
        refreshTask = nil
        refreshPending = false
    }
}
