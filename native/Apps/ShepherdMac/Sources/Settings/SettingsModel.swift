import Foundation
import Observation
import ShepherdKit

struct SettingsSnapshot: Sendable {
    var settings: Components.Schemas.Settings
    var diagnostics: DiagnosticsSnapshot
    var usage: UsageLimits?
    var repos: [Components.Schemas.Repo]
}
struct SettingsReads: Sendable {
    var snapshot: @Sendable () async throws -> SettingsSnapshot
    var reconcile: @MainActor @Sendable () async throws -> Void = {}
    @MainActor static func live(_ store: SessionStore) -> Self {
        let client = store.client
        return .init(snapshot: {
            async let settings = client.settings()
            async let diagnostics = client.getDiagnostics()
            async let usage = client.usage()
            async let repos = client.repos()
            return try await .init(settings: settings, diagnostics: diagnostics,
                usage: usage.limits, repos: repos.repos)
        }, reconcile: { try await store.refresh() })
    }
}
@Observable @MainActor final class SettingsModel: AppExtension {
    private(set) var snapshot: SettingsSnapshot?
    private(set) var error: String?
    private(set) var busy = false
    var repo = ""
    var repoConfig: RepoConfig?
    var roles: RepoRolesResult?
    var collaborators: RepoCollaborators?
    var directories: DirectoryListing?
    var verification: KeyVerification?
    let tokens = SettingsTokensModel()
    @ObservationIgnored private let reads: SettingsReads
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var stopped = false
    @ObservationIgnored private var tap: Task<Void,Never>?
    @ObservationIgnored private var loadTask: Task<Void,Never>?
    @ObservationIgnored private var writeTask: Task<Void,Never>?
    @ObservationIgnored private var watcher: Task<Void,Never>?
    @ObservationIgnored private var wake: AsyncStream<Void>.Continuation?
    init(reads: SettingsReads) { self.reads = reads }
    init(store: SessionStore, app: AppModel) {
        self.app = app; reads = .live(store)
        let activation = app.activationGeneration
        tap = Task { [weak self, weak store] in
            guard let store else { return }
            for await event in store.events() {
                guard let self, !self.stopped, self.app?.activationGeneration == activation,
                    !Task.isCancelled else { return }
                if case .unknown(let name, _) = event, name == "diagnostics:status" { self.reload() }
                if case .usageLimits = event { self.reload() }
            }
        }
        let (stream, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        wake = continuation
        watcher = Task { [weak self, weak store] in
            guard let store else { return }
            var iterator = stream.makeAsyncIterator(), live = false
            while let self, !self.stopped, self.app?.activationGeneration == activation, !Task.isCancelled {
                let connection = withObservationTracking { store.connection }
                    onChange: { continuation.yield(()) }
                if connection == .live && !live { self.reload() }
                live = connection == .live
                guard await iterator.next() != nil else { return }
            }
        }
        reload()
    }
    func reload() {
        guard !stopped else { return }
        generation &+= 1; loadTask?.cancel()
        loadTask = Task { [weak self] in await self?.load() }
    }
    func load() async {
        guard !stopped, !Task.isCancelled else { return }
        // Direct loads need their own revision too; reload invalidates immediately on scheduling.
        generation &+= 1
        let mine = generation, activation = app?.activationGeneration
        do {
            let value = try await reads.snapshot()
            guard valid(mine, activation), !Task.isCancelled else { return }
            snapshot = value; error = nil
            if !value.repos.contains(where: { $0.path == repo }) {
                repo = ""; repoConfig = nil; roles = nil; collaborators = nil
            }
        } catch {
            guard valid(mine, activation), !Task.isCancelled else { return }
            self.error = L.t("native_settings_load_failed")
        }
    }
    private func valid(_ mine: Int, _ activation: Int?) -> Bool {
        !stopped && mine == generation && activation == app?.activationGeneration
    }
    func run<Value: Sendable>(
        _ operation: @escaping @Sendable () async throws -> Value,
        commit: @escaping @MainActor (Value) -> Void = { _ in }
    ) {
        guard !stopped, !busy else { return }
        busy = true; error = nil
        // Reconnects may invalidate reads but must not strand the write's busy flag.
        let activation = app?.activationGeneration
        writeTask = Task { [weak self] in
            do {
                let value = try await operation()
                guard let self, !self.stopped, self.app?.activationGeneration == activation,
                    !Task.isCancelled else { return }
                // Other streams read SessionStore.settings/repos (composer defaults and root).
                // A SettingsModel-only GET would leave those consumers stale until reconnect.
                try await self.reads.reconcile()
                guard !self.stopped, self.app?.activationGeneration == activation,
                    !Task.isCancelled else { return }
                commit(value); self.busy = false; self.reload()
            } catch {
                guard let self, !self.stopped, self.app?.activationGeneration == activation,
                    !Task.isCancelled else { return }
                self.busy = false; self.error = L.t("native_settings_action_failed")
            }
        }
    }
    func replaceDiagnostics(_ value: DiagnosticsSnapshot) { snapshot?.diagnostics = value }
    func patch(_ body: SettingsPatch, client: ShepherdClient) {
        run { try await client.patchSettings(body: body) }
    }
    func selectRepo(_ path: String, client: ShepherdClient) {
        guard !stopped, !busy else { return }
        repo = path; repoConfig = nil; roles = nil; collaborators = nil
        run({
            async let config = client.getRepoConfig(repo: path)
            async let roles = client.getRepoRoles(repo: path)
            async let people = client.getRepoCollaborators(repo: path)
            return try await (config, roles, people)
        }, commit: { [weak self] value in
            guard let self, self.repo == path else { return }
            self.repoConfig = value.0; self.roles = value.1; self.collaborators = value.2
        })
    }
    func teardown() {
        stopped = true; generation &+= 1
        wake?.finish(); wake = nil
        tap?.cancel(); loadTask?.cancel(); writeTask?.cancel(); watcher?.cancel()
        tap = nil; loadTask = nil; writeTask = nil; watcher = nil
        tokens.close(); snapshot = nil; repoConfig = nil; roles = nil; collaborators = nil
        directories = nil; verification = nil; repo = ""; busy = false; error = nil; app = nil
    }
}
