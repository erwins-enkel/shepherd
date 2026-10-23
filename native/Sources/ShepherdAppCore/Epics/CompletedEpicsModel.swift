import Foundation
import Observation
import ShepherdKit

/// The band's one read and five writes. Swappable so tests drive the model without a server.
struct CompletedEpicsAPI: Sendable {
    var list: @Sendable () async throws -> [CompletedEpic]
    var land: @Sendable (String, Int) async throws -> Void = { _, _ in }
    var dismiss: @Sendable (String, Int) async throws -> Void = { _, _ in }
    var ackMigrations: @Sendable (String, Int) async throws -> Void = { _, _ in }
    var resolveConflicts: @Sendable (String, Int) async throws -> Void = { _, _ in }
    var repairCi: @Sendable (String, Int) async throws -> Void = { _, _ in }

    static func live(_ client: ShepherdClient) -> Self {
        .init(
            list: { try await client.completedEpics() },
            land: { try await client.landCompletedEpic(repo: $0, parent: $1) },
            dismiss: { try await client.dismissCompletedEpic(repo: $0, parent: $1) },
            ackMigrations: { try await client.ackCompletedEpicMigrations(repo: $0, parent: $1) },
            resolveConflicts: { try await client.resolveCompletedEpicConflicts(repo: $0, parent: $1) },
            repairCi: { try await client.repairCompletedEpicCi(repo: $0, parent: $1) })
    }
}

/// The "Epics to land" band of one server (#2856, #2857): bootstrapped from
/// GET /api/epics/completed, kept live by epic:completed / epic:completed-cleared, re-read on
/// every connection to `.live`.
///
/// The frames never carry the live landing signals (green CI, ready to land, stranded), and no
/// frame fires when they change, so a view re-reads `refresh()` while `hasOpenLanding` holds —
/// the web does so every 60 s while visible.
@Observable @MainActor
public final class CompletedEpicsModel: AppExtension {
    /// Newest first, as the server lists them. `CompletedEpicsBand.sorted` orders the band.
    public private(set) var epics: [CompletedEpic] = []
    public private(set) var loaded = false
    public private(set) var loadFailed = false
    /// Rows whose land request is in flight: the merge runs inside the POST.
    public private(set) var landing: Set<String> = []
    /// Rows whose repair or conflict agent is being started.
    public private(set) var starting: Set<String> = []
    /// The last action that failed, worded for the operator. The next action clears it.
    public private(set) var actionError: String?

    public var hasOpenLanding: Bool { epics.contains { $0.landingState.rawValue == "open" } }

    @ObservationIgnored let api: CompletedEpicsAPI
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var stopped = false
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var pending = false
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var watchTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var wake: AsyncStream<Void>.Continuation?

    /// Test seam: no app, socket or automatic bootstrap.
    init(api: CompletedEpicsAPI) { self.api = api }

    public init(store: SessionStore, app: AppModel) {
        api = .live(store.client)
        self.app = app
        let activation = app.activationGeneration
        eventTask = Task { [weak self, weak store] in
            guard let store else { return }
            for await event in store.events() {
                guard let self, self.valid(activation), !Task.isCancelled else { return }
                if case .unknown(let name, let payload) = event { self.receive(name: name, payload: payload) }
            }
        }
        // Bootstraps on the first `.live` and re-reads after every reconnect: frames sent while
        // the socket was down are gone.
        let (stream, signal) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        wake = signal
        watchTask = Task { [weak self, weak store] in
            guard let store else { return }
            var iterator = stream.makeAsyncIterator()
            var wasLive = false
            while let self, self.valid(activation), !Task.isCancelled {
                let live = withObservationTracking { store.connection == .live } onChange: { signal.yield(()) }
                if live && !wasLive { self.invalidate() }
                wasLive = live
                guard await iterator.next() != nil else { return }
            }
        }
    }

    private func valid(_ activation: Int?) -> Bool { !stopped && activation == app?.activationGeneration }

    func receive(name: String, payload: Data?) {
        switch name {
        case "epic:completed":
            guard let payload, let epic = try? JSONDecoder().decode(CompletedEpic.self, from: payload) else {
                invalidate()
                return
            }
            let key = CompletedEpicsBand.key(epic)
            epics.removeAll { CompletedEpicsBand.key($0) == key }
            epics.insert(epic, at: 0)
            revision &+= 1
            pruneLanding()
            // The frame drops the live signals; an open landing needs the GET to show them again.
            if epic.landingState.rawValue == "open" { invalidate() }
        case "epic:completed-cleared":
            guard let payload,
                  let cleared = try? JSONDecoder().decode(CompletedEpicClearedEvent.self, from: payload) else {
                invalidate()
                return
            }
            epics.removeAll {
                $0.repoPath == cleared.repoPath && $0.parentIssueNumber == cleared.parentIssueNumber
            }
            revision &+= 1
            pruneLanding()
        default: break
        }
    }

    /// Schedules a re-read. Coalesces: one GET in flight, at most one queued behind it.
    public func invalidate() {
        guard !stopped else { return }
        revision &+= 1
        pending = true
        guard !refreshing else { return }
        refreshTask = Task { [weak self] in await self?.refresh() }
    }

    public func refresh() async {
        guard !stopped else { return }
        if refreshing { pending = true; return }
        refreshing = true
        let activation = app?.activationGeneration
        defer { refreshing = false }
        repeat {
            pending = false
            let started = revision
            do {
                let rows = try await api.list()
                guard valid(activation), !Task.isCancelled else { return }
                // A frame or an action during the GET makes the answer suspect. Re-read instead.
                if started != revision { pending = true; continue }
                epics = rows
                loaded = true
                loadFailed = false
                pruneLanding()
            } catch {
                guard valid(activation), !Task.isCancelled else { return }
                loaded = true
                loadFailed = true
            }
        } while pending && !stopped
    }

    /// A land stays in flight only while its row is still listed with an open landing PR.
    private func pruneLanding() {
        landing = landing.filter { key in
            epics.contains { CompletedEpicsBand.key($0) == key && $0.landingState.rawValue == "open" }
        }
    }

    public func status(_ epic: CompletedEpic) -> CompletedEpicStatus {
        CompletedEpicStatus(epic, landing: landing.contains(CompletedEpicsBand.key(epic)))
    }

    public func card(_ epic: CompletedEpic, now: Int) -> CompletedEpicCard {
        CompletedEpicCard(epic, now: now, landing: landing.contains(CompletedEpicsBand.key(epic)))
    }

    public func clearError() { actionError = nil }

    /// Merges the landing PR. Only a row the server last reported ready can land.
    public func land(_ epic: CompletedEpic) {
        let key = CompletedEpicsBand.key(epic)
        guard !stopped, !landing.contains(key), CompletedEpicStatus(epic).canLand else { return }
        landing.insert(key)
        actionError = nil
        let activation = app?.activationGeneration
        let send = api.land
        let failure = L.t("integrated_epics_land_failed")
        Task { [weak self] in
            do {
                try await send(epic.repoPath, epic.parentIssueNumber)
                guard let self, self.valid(activation) else { return }
                // The in-flight state ends once a frame or a re-read shows the row landed (see
                // pruneLanding), so the card never flashes back to "Land epic" on stale data.
                self.invalidate()
            } catch {
                guard let self, self.valid(activation) else { return }
                self.landing.remove(key)
                self.actionError = failure
                // The likeliest refusal (not ready, merge failed) means the row is stale.
                self.invalidate()
            }
        }
    }

    /// Removes the row. It only hides it: the landing PR, the branch and the issue stay.
    public func dismiss(_ epic: CompletedEpic) {
        remove(epic, failure: L.t("integrated_epics_dismiss_failed"), api.dismiss)
    }

    /// Acknowledges the landing PR's migrations, which also removes the row.
    public func ackMigrations(_ epic: CompletedEpic) {
        remove(epic, failure: L.t("integrated_epics_ack_migrations_failed"), api.ackMigrations)
    }

    public func resolveConflicts(_ epic: CompletedEpic) {
        dispatch(epic, failure: L.t("integrated_epics_resolve_conflicts_failed"), api.resolveConflicts)
    }

    public func repairCi(_ epic: CompletedEpic) {
        dispatch(epic, failure: L.t("integrated_epics_repair_ci_failed"), api.repairCi)
    }

    /// Optimistic: the row goes at once. On failure it comes back, unless a frame already did.
    private func remove(_ epic: CompletedEpic, failure: String,
                        _ send: @escaping @Sendable (String, Int) async throws -> Void) {
        let key = CompletedEpicsBand.key(epic)
        guard !stopped, let index = epics.firstIndex(where: { CompletedEpicsBand.key($0) == key }) else { return }
        let removed = epics.remove(at: index)
        revision &+= 1
        actionError = nil
        let activation = app?.activationGeneration
        Task { [weak self] in
            do {
                try await send(removed.repoPath, removed.parentIssueNumber)
            } catch {
                guard let self, self.valid(activation) else { return }
                if !self.epics.contains(where: { CompletedEpicsBand.key($0) == key }) {
                    self.epics.insert(removed, at: 0)
                }
                self.actionError = failure
            }
        }
    }

    /// Starts an agent on the landing PR. Either way the row is re-read: whether a repair is
    /// running is a live signal only the GET carries.
    private func dispatch(_ epic: CompletedEpic, failure: String,
                          _ send: @escaping @Sendable (String, Int) async throws -> Void) {
        let key = CompletedEpicsBand.key(epic)
        guard !stopped, !starting.contains(key) else { return }
        starting.insert(key)
        actionError = nil
        let activation = app?.activationGeneration
        Task { [weak self] in
            var failed = false
            do { try await send(epic.repoPath, epic.parentIssueNumber) } catch { failed = true }
            guard let self, self.valid(activation) else { return }
            self.starting.remove(key)
            if failed { self.actionError = failure }
            self.invalidate()
        }
    }

    public func teardown() {
        guard !stopped else { return }
        stopped = true
        revision &+= 1
        wake?.finish()
        wake = nil
        eventTask?.cancel()
        watchTask?.cancel()
        refreshTask?.cancel()
        eventTask = nil
        watchTask = nil
        refreshTask = nil
        app = nil
        pending = false
    }
}
