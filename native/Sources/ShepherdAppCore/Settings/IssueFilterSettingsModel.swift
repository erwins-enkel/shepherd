import Foundation
import Observation
import ShepherdKit

struct IssueFilterReads: Sendable {
    /// nil = a server without the setting.
    var read: @Sendable () async throws -> IssueFilterSettings?
    /// The server's merged value after the PATCH.
    var write: @Sendable (IssueFilterPatch) async throws -> IssueFilterSettings?

    static func live(_ client: ShepherdClient) -> Self {
        .init(read: {
            try await client.settings().issueFilter.map { try IssueFilterSettings.bridged($0) }
        }, write: { patch in
            try await client.patchSettings(body: .init(issueFilter: patch.generated()))
                .issueFilter.map { try IssueFilterSettings.bridged($0) }
        })
    }
}

/// The operator's server-persisted default issue filter (#3017), shared by every native surface
/// that shows issues (Up Next, New Task, Settings; iOS reuses it). Reads /api/settings, follows
/// the `settings:issue-filter` push, re-reads on every reconnect, and writes optimistically — a
/// failed write reverts to the last server-confirmed value. Mirrors
/// ui/src/lib/issue-filter-settings.svelte.ts.
@Observable @MainActor public final class IssueFilterSettingsModel: AppExtension {
    /// nil = not loaded yet, or a server without the setting (surfaces hide their filter UI).
    public private(set) var value: IssueFilterSettings? = nil
    public private(set) var error: String? = nil
    /// What issue lists filter by: the server value, or the defaults until it loads.
    public var effective: IssueFilterSettings { value ?? .defaults }

    @ObservationIgnored private var confirmed: IssueFilterSettings?
    @ObservationIgnored private let reads: IssueFilterReads
    @ObservationIgnored private let repos: @MainActor () -> [Repo]
    @ObservationIgnored private var seq = 0
    @ObservationIgnored private var stopped = false
    @ObservationIgnored private var tap: Task<Void, Never>?
    @ObservationIgnored private var watcher: Task<Void, Never>?
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var wake: AsyncStream<Void>.Continuation?

    init(reads: IssueFilterReads, repos: @escaping @MainActor () -> [Repo] = { [] },
         initial: IssueFilterSettings? = nil) {
        self.reads = reads; self.repos = repos
        value = initial; confirmed = initial
    }

    public init(store: SessionStore, app: AppModel) {
        reads = .live(store.client)
        repos = { [weak store] in store?.repos ?? [] }
        let initial = try? store.settings?.issueFilter.map { try IssueFilterSettings.bridged($0) }
        value = initial; confirmed = initial
        let activation = app.activationGeneration
        let frames = store.events()
        tap = Task { [weak self, weak app] in
            for await event in frames {
                guard let self, !self.stopped, app?.activationGeneration == activation,
                    !Task.isCancelled else { return }
                self.apply(event)
            }
        }
        let (stream, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        wake = continuation
        watcher = Task { [weak self, weak store, weak app] in
            var iterator = stream.makeAsyncIterator(), live = false
            while let self, let store, !self.stopped, app?.activationGeneration == activation, !Task.isCancelled {
                let connection = withObservationTracking { store.connection }
                    onChange: { continuation.yield(()) }
                // A push may have been missed while the socket was down.
                if connection == .live && !live { self.reload() }
                live = connection == .live
                guard await iterator.next() != nil else { return }
            }
        }
    }

    public func teardown() {
        stopped = true
        tap?.cancel(); watcher?.cancel(); loadTask?.cancel()
        wake?.finish()
    }

    public func reload() {
        guard !stopped else { return }
        loadTask?.cancel()
        loadTask = Task { [weak self] in await self?.load() }
    }

    func load() async {
        let mine = seq
        guard let next = try? await reads.read(), !stopped, !Task.isCancelled else { return }
        // A write started meanwhile owns the value until it settles.
        guard mine == seq else { return }
        value = next; confirmed = next
    }

    func apply(_ event: ServerEvent) {
        guard case .unknown(name: "settings:issue-filter", payload: let payload?) = event,
              let frame = try? JSONDecoder().decode(Components.Schemas.SettingsIssueFilterEvent.self, from: payload),
              let next = try? IssueFilterSettings.bridged(frame.issueFilter) else { return }
        value = next; confirmed = next
    }

    /// Optimistic PATCH; the returned task settles it (tests await it).
    @discardableResult
    public func update(_ patch: IssueFilterPatch) -> Task<Void, Never>? {
        guard !stopped, let current = value, !patch.isEmpty else { return nil }
        seq &+= 1
        let mine = seq
        value = current.applying(patch); error = nil
        return Task { [weak self, reads] in
            do {
                let result = try await reads.write(patch)
                guard let self, !self.stopped else { return }
                self.confirmed = result ?? (self.confirmed ?? current).applying(patch)
                if mine == self.seq { self.value = self.confirmed }
            } catch {
                // A superseded write leaves the outcome to the latest one.
                guard let self, !self.stopped, mine == self.seq else { return }
                self.value = self.confirmed
                self.error = L.t("upnext_filter_save_failed")
            }
        }
    }

    /// Up Next's rules only; the Backlog/New Task toggles are not part of this reset (as on the web).
    @discardableResult
    public func reset() -> Task<Void, Never>? {
        let base = IssueFilterSettings.defaults
        return update(.init(scope: base.scope, forks: base.forks, hiddenLabels: []))
    }

    public func clearError() { error = nil }

    /// The override stored for a repo: keys are realpaths, but either path form resolves.
    public func override(for repo: Repo) -> IssueFilterSettings.RepoOverride? {
        let map = effective.repoOverrides
        return map[repo.realPath] ?? map[repo.path]
    }

    /// nil clears the repo's exception (it follows the default rules again).
    @discardableResult
    public func setOverride(_ override: IssueFilterSettings.RepoOverride?, for repo: Repo) -> Task<Void, Never>? {
        var map = effective.repoOverrides
        map[repo.path] = nil
        map[repo.realPath] = override
        return update(.init(repoOverrides: map))
    }

    /// The repo facts the rules read for an issue list from `repoPath`.
    public func repoContext(for repoPath: String) -> IssueFilter.RepoContext {
        guard let repo = repos().first(where: { $0.path == repoPath || $0.realPath == repoPath }) else {
            return .init(override: effective.repoOverrides[repoPath])
        }
        return .init(isFork: repo.isFork, override: override(for: repo))
    }
}
