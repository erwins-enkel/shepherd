import Foundation
import Observation
import ShepherdKit

struct MergeSnapshot: Sendable {
    var automation: [Components.Schemas.AutoMergeStatus] = []
    var drain: [DrainStatus] = []
    var queues: [String: BuildQueue] = [:]
    var owed: [PostMergeSteps] = []
}
enum MergeQueueState {
    case unloaded
    case failed
    case loaded(BuildQueue)

    var queue: BuildQueue? {
        guard case .loaded(let queue) = self else { return nil }
        return queue
    }
}
struct MergeReads: Sendable {
    var snapshot: @Sendable () async throws -> MergeSnapshot
    var sessionRows: @MainActor @Sendable () async throws -> Void = {}
    @MainActor static func live(_ store: SessionStore) -> Self {
        let client = store.client
        return .init(snapshot: {
            async let auto = client.listAutomerge()
            async let drain = client.listDrain()
            async let queues = client.listBuildQueues()
            async let owed = client.listOutstandingManualSteps()
            return try await MergeSnapshot(automation: auto, drain: drain, queues: queues, owed: owed)
        }, sessionRows: { try await store.refresh() })
    }
}
@Observable @MainActor
final class MergeModel: AppExtension {
    private(set) var snapshot = MergeSnapshot()
    private(set) var actionError: String?
    private var refreshError: String?
    // Every merge surface keeps the last action refusal visible across background reads.
    var error: String? { actionError ?? refreshError }
    private(set) var busy = false
    private(set) var settled = false
    private(set) var watching = false
    var showOverview = false
    @ObservationIgnored private let reads: MergeReads
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private weak var store: SessionStore?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var stopped = false
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var pending = false
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var watchTask: Task<Void, Never>?
    @ObservationIgnored private var writeTask: Task<Void, Never>?
    @ObservationIgnored private var writeSequence = 0
    @ObservationIgnored private var wake: AsyncStream<Void>.Continuation?

    init(reads: MergeReads) { self.reads = reads }
    init(store: SessionStore, app: AppModel) {
        self.store = store; self.app = app; self.reads = .live(store)
        let mine = generation
        let activation = app.activationGeneration
        // Subscribe before scheduling the bootstrap. Buffered old frames are generation-guarded.
        eventTask = Task { [weak self, weak store] in
            guard let store else { return }
            for await event in store.events() {
                guard let self, self.valid(mine, activation), !Task.isCancelled else { return }
                switch event {
                case .automergeStatus, .sessionNew, .sessionArchived, .sessionStatus:
                    self.invalidate()
                case .unknown(let name, _):
                    self.receive(name: name)
                default: break
                }
            }
        }
        let (stream, signal) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        wake = signal
        watchTask = Task { [weak self, weak store] in
            guard let store else { return }
            self?.watching = true
            defer { self?.watching = false }
            var iterator = stream.makeAsyncIterator()
            var wasLive = false
            while let self, self.valid(mine, activation), !Task.isCancelled {
                let state = withObservationTracking {
                    (store.connection, Set(store.sessions.map(\.id)))
                } onChange: { signal.yield(()) }
                self.prune(liveIDs: state.1)
                let live = state.0 == .live
                if live && !wasLive { self.invalidate() }
                wasLive = live
                guard await iterator.next() != nil else { return }
            }
        }
        invalidate()
    }
    static let refreshEvents: Set<String> = ["session:automerge", "session:autopilot",
        "session:merging", "mergetrain:landed", "post-merge-steps:changed",
        "session:manual-steps", "queue:update", "drain:status"]
    private func valid(_ mine: Int, _ activation: Int?) -> Bool {
        !stopped && mine == generation && activation == app?.activationGeneration
    }
    func receive(name: String) {
        guard Self.refreshEvents.contains(name) else { return }
        invalidate()
    }
    func invalidate() {
        guard !stopped else { return }
        revision &+= 1
        pending = true
        guard !refreshing else { return }
        refreshTask = Task { [weak self] in await self?.refresh() }
    }
    func refresh() async {
        guard !stopped else { return }
        if refreshing { pending = true; return }
        refreshing = true
        let mine = generation, activation = app?.activationGeneration
        defer { refreshing = false }
        repeat {
            pending = false
            let started = revision
            do {
                // SessionStore ignores these frames. Refresh its session rows too, so another
                // client's autopilot/ack change and merge-train progress reach the controls.
                try await reads.sessionRows()
                guard valid(mine, activation), !Task.isCancelled else { return }
                let value = try await reads.snapshot()
                guard valid(mine, activation), !Task.isCancelled else { return }
                // A frame during the GET makes the snapshot suspect. Re-read, don't overwrite it.
                if started != revision { pending = true; continue }
                snapshot = value
                if let store { prune(liveIDs: Set(store.sessions.map(\.id))) }
                refreshError = nil; settled = true
            } catch {
                guard valid(mine, activation), !Task.isCancelled else { return }
                self.refreshError = L.t("native_merge_load_failed"); settled = true
            }
        } while pending && !stopped
    }
    func queueState(id: String) -> MergeQueueState {
        guard !stopped, settled else { return .unloaded }
        guard refreshError == nil else { return .failed }
        // Only a successful bulk snapshot can prove that a queue is empty.
        return .loaded(snapshot.queues[id] ?? .init(sessionId: id, steps: [], approved: false))
    }
    func editQueue(
        id: String,
        edit: (inout [BuildStep]) -> Void,
        send: @escaping @MainActor (BuildQueueWrite) async throws -> BuildQueue
    ) {
        guard !busy, case .loaded(let queue) = queueState(id: id),
              queue.steps.allSatisfy({ $0.status.known != nil }) else { return }
        var steps = queue.steps
        edit(&steps)
        guard steps != queue.steps, steps.allSatisfy({ $0.status.known != nil }) else { return }
        let rows = steps.map { BuildStepInput(id: $0.id, title: $0.title, detail: $0.detail,
            status: .init(rawValue: $0.status.rawValue)) }
        perform(commit: { [weak self] queue in
            // perform commits synchronously before busy becomes false. Its invalidation
            // also prevents an older, in-flight snapshot from undoing this response.
            self?.snapshot.queues[id] = queue
        }) { try await send(.init(steps: rows)) }
    }
    func prune(liveIDs: Set<String>) {
        snapshot.queues = snapshot.queues.filter { liveIDs.contains($0.key) }
        // Owed records deliberately survive archive AND physical session pruning.
        // Automation/drain are repo-keyed, not session-keyed; replace them on full refresh.
    }
    var outstanding: [String: Int] {
        Dictionary(uniqueKeysWithValues: snapshot.owed.filter { $0.clearedAt == nil }.map {
            ($0.sessionId, $0.steps.filter { $0.doneAt == nil }.count)
        })
    }
    func perform<Value: Sendable>(
        queueIfBusy: Bool = false,
        commit: @escaping @MainActor (Value) -> Void = { _ in },
        failure: @escaping @MainActor () -> Void = {},
        _ action: @escaping @MainActor () async throws -> Value
    ) {
        guard !stopped, !busy || queueIfBusy else { return }
        let previousWrite = busy ? writeTask : nil
        writeSequence &+= 1
        let sequence = writeSequence
        busy = true; actionError = nil
        let mine = generation, activation = app?.activationGeneration
        writeTask = Task { [weak self] in
            await withTaskCancellationHandler {
                await previousWrite?.value
            } onCancel: {
                previousWrite?.cancel()
            }
            guard let self, self.valid(mine, activation), !Task.isCancelled else { return }
            do {
                let value = try await action()
                guard self.valid(mine, activation), !Task.isCancelled else { return }
                commit(value)
                if sequence == self.writeSequence { self.busy = false }
                self.invalidate()
            } catch {
                guard self.valid(mine, activation), !Task.isCancelled else { return }
                if sequence == self.writeSequence { self.busy = false }
                self.actionError = ShepherdErrorCopy.message(error)
                failure()
            }
        }
    }
    func teardown() {
        guard !stopped else { return }
        stopped = true; generation &+= 1; revision &+= 1
        wake?.finish(); wake = nil
        eventTask?.cancel(); watchTask?.cancel(); refreshTask?.cancel(); writeTask?.cancel()
        eventTask = nil; watchTask = nil; refreshTask = nil; writeTask = nil
        store = nil; app = nil; busy = false; pending = false
    }
}
