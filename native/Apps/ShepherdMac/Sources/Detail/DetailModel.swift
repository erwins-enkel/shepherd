import Foundation
import Observation
import ShepherdKit

/// Where one tab's data stands. `failed` carries copy that has already been through
/// `ShepherdErrorCopy`, so a view never maps an error itself.
enum Loaded<Value: Equatable & Sendable>: Equatable, Sendable {
    case idle
    case loading
    case ready(Value)
    case failed(String)

    var value: Value? {
        if case .ready(let value) = self { return value }
        return nil
    }
    var isLoading: Bool {
        if case .loading = self { return true }
        return false
    }
    var failure: String? {
        if case .failed(let message) = self { return message }
        return nil
    }
}

/// The four detail tabs, and how often a visible one re-reads on a timer.
///
/// Only `diff` polls: the contract declares no push for it, and the web UI polls it
/// unconditionally too (`DiffPanel` 15 s). `activity` and `git` instead refresh from
/// `session:activity`/`session:git` pushes — see `DetailModel.subscribe(_:)` — so they carry no
/// interval here; `poll(_:session:)` degrades to a single load for them, same as `files`, which
/// neither polls nor pushes and reloads only when the operator navigates or presses Refresh.
enum DetailFeed: String, CaseIterable, Sendable {
    case activity, diff, files, git

    var interval: Duration? {
        switch self {
        case .diff: .seconds(15)
        case .activity, .files, .git: nil
        }
    }
}

/// Per-server caches for the detail tabs.
///
/// One instance per `SessionStore`: `AppModel` builds it in `activate(_:)` and calls
/// `teardown()` when the store goes away, so a read that comes back after a profile switch
/// finds `alive == false` and touches nothing. Keyed by session id because the operator can
/// switch rows faster than a request completes.
@Observable
@MainActor
final class DetailModel: AppExtension {
    struct DiffPayload: Equatable, Sendable {
        var result: DiffResult
        /// Empty when the annotations read failed: they are chrome, and a diff must not vanish
        /// because its notes did.
        var notes: [DiffNote]
    }

    enum FilesSource: String, CaseIterable, Sendable { case scratchpad, worktree }

    struct FilesPayload: Equatable, Sendable {
        var source: FilesSource
        var listing: BrowseListing
    }

    /// Every server read, as closures, so tests drive the model without a server.
    struct Loaders: Sendable {
        var activity: @MainActor (String) async throws -> [ActivityEntry]
        var diff: @MainActor (String) async throws -> DiffResult
        var annotations: @MainActor (String) async throws -> [DiffNote]
        var scratchpad: @MainActor (String, String?) async throws -> BrowseListing
        var worktree: @MainActor (String, String?) async throws -> BrowseListing
        var git: @MainActor (String) async throws -> GitState?

        static func live(_ client: ShepherdClient) -> Loaders {
            Loaders(
                activity: { try await client.activity(sessionID: $0) },
                diff: { try await client.diff(sessionID: $0) },
                annotations: { try await client.diffAnnotations(sessionID: $0) },
                scratchpad: { try await client.scratchpad(sessionID: $0, path: $1) },
                worktree: { try await client.worktreeFiles(sessionID: $0, path: $1) },
                git: { try await client.git(sessionID: $0) })
        }

        /// Empty answers for every read — a test overrides only the one it is about.
        static func stubbed() -> Loaders {
            Loaders(
                activity: { _ in [] },
                diff: { _ in
                    DiffResult(
                        base: "main", baseRef: "main", head: nil, fetchFailed: false,
                        truncated: false, files: [])
                },
                annotations: { _ in [] },
                scratchpad: { _, path in BrowseListing(path: path ?? "", parent: nil, entries: []) },
                worktree: { _, path in BrowseListing(path: path ?? "", parent: nil, entries: []) },
                git: { _ in nil })
        }
    }

    private(set) var activity: [String: Loaded<[ActivityEntry]>] = [:]
    private(set) var diff: [String: Loaded<DiffPayload>] = [:]
    private(set) var files: [String: Loaded<FilesPayload>] = [:]
    private(set) var git: [String: Loaded<GitState?>] = [:]

    /// How a poll waits. Replaced in tests so the loop runs at full speed.
    @ObservationIgnored var sleep: @Sendable (Duration) async throws -> Void = {
        try await Task.sleep(for: $0)
    }

    private let loaders: Loaders
    /// False after `teardown()`. Every completion checks it, so a read that outlives the store
    /// it was made against writes nothing.
    @ObservationIgnored private var alive = true
    /// Bumped at the start of every load, per feed and session. A completion whose stamp is no
    /// longer the newest is dropped: a poll tick and a manual Refresh overlap routinely, and the
    /// earlier one holds the older answer by construction.
    @ObservationIgnored private var stamps: [String: Int] = [:]
    /// The `session:activity`/`session:git` tap. Ended by `teardown()`; also ends on its own once
    /// `store.events()` finishes, which happens when the store's `stop()` runs.
    @ObservationIgnored private var watcher: Task<Void, Never>?

    init(store: SessionStore, app: AppModel) {
        self.loaders = .live(store.client)
        subscribe(store)
    }

    /// Test initialiser: the same model with hand-driven reads and no event tap — tests drive
    /// `load`/`poll` directly instead of pushing frames through a store.
    init(loaders: Loaders) { self.loaders = loaders }

    func teardown() {
        alive = false
        watcher?.cancel()
        watcher = nil
    }

    /// Reads one feed for one session. Safe to call while a read is already in flight.
    func load(_ feed: DetailFeed, session id: String) async {
        let stamp = nextStamp(feed, id)
        set(feed, id, .loading)
        do {
            switch feed {
            case .activity:
                let entries = try await loaders.activity(id)
                commit(feed, id, stamp) { self.activity[id] = .ready(entries) }
            case .diff:
                let result = try await loaders.diff(id)
                var notes: [DiffNote] = []
                do { notes = try await loaders.annotations(id) } catch {
                    Log.ui.debug("diff annotations failed; keeping the diff")
                }
                commit(feed, id, stamp) {
                    self.diff[id] = .ready(DiffPayload(result: result, notes: notes))
                }
            case .files:
                let listing = try await loaders.scratchpad(id, nil)
                commit(feed, id, stamp) {
                    self.files[id] = .ready(FilesPayload(source: .scratchpad, listing: listing))
                }
            case .git:
                let state = try await loaders.git(id)
                commit(feed, id, stamp) { self.git[id] = .ready(state) }
            }
        } catch {
            let copy = ShepherdErrorCopy.message(error)
            commit(feed, id, stamp) { self.set(feed, id, .failed(copy)) }
        }
    }

    /// Lists one directory of one files source, replacing whatever the files tab held.
    func browse(session id: String, source: FilesSource, path: String?) async {
        let stamp = nextStamp(.files, id)
        set(.files, id, .loading)
        do {
            let listing: BrowseListing
            switch source {
            case .scratchpad: listing = try await loaders.scratchpad(id, path)
            case .worktree: listing = try await loaders.worktree(id, path)
            }
            commit(.files, id, stamp) {
                self.files[id] = .ready(FilesPayload(source: source, listing: listing))
            }
        } catch {
            let copy = ShepherdErrorCopy.message(error)
            commit(.files, id, stamp) { self.set(.files, id, .failed(copy)) }
        }
    }

    /// Loads once, then re-loads on the feed's interval until the calling task is cancelled. A
    /// view runs this from `.task(id:)`, which cancels it when the session or tab changes.
    func poll(_ feed: DetailFeed, session id: String) async {
        guard let interval = feed.interval else {
            await load(feed, session: id)
            return
        }
        while !Task.isCancelled {
            await load(feed, session: id)
            do { try await self.sleep(interval) } catch { return }
        }
    }

    /// Re-reads git after an action, so the panel shows what the server now believes rather than
    /// what the action returned.
    func refreshGit(session id: String) async { await load(.git, session: id) }

    /// Keeps `activity`/`git` current without a timer. `session:activity`/`session:git` are
    /// declared under this stream's own `x-shepherd-events` block but never added to `EventName`
    /// (Decision 3), so they arrive through `store.events()` as
    /// `ServerEvent.unknown(name:payload:)`: match the raw name, decode `payload` into the schema
    /// this stream's own contract block names, and reload exactly the session id the frame
    /// carries — never every open tab. `load(_:session:)`'s own `commit(_:_:_:_:)` already drops a
    /// write once `alive` is false, so this loop needs no liveness check beyond `weak self`, and
    /// it ends on its own once `store.events()` finishes on `stop()`, or sooner if `teardown()`
    /// cancels it directly.
    private func subscribe(_ store: SessionStore) {
        watcher = Task { @MainActor [weak self] in
            for await event in store.events() {
                guard let self else { return }
                guard case .unknown(let name, let payload) = event, let payload else { continue }
                switch name {
                case "session:activity":
                    guard
                        let decoded = try? JSONDecoder().decode(
                            SessionActivityEvent.self, from: payload)
                    else { continue }
                    await self.load(.activity, session: decoded.id)
                case "session:git":
                    guard
                        let decoded = try? JSONDecoder().decode(SessionGitEvent.self, from: payload)
                    else { continue }
                    await self.load(.git, session: decoded.id)
                default:
                    continue
                }
            }
        }
    }

    // MARK: - Internals

    /// The two states that carry no value. A single `Loaded` value cannot be written into four
    /// differently-typed dictionaries, so this carries the intent instead.
    private enum Mark { case loading, failed(String) }

    private func key(_ feed: DetailFeed, _ id: String) -> String { "\(feed.rawValue):\(id)" }

    private func nextStamp(_ feed: DetailFeed, _ id: String) -> Int {
        let next = (stamps[key(feed, id)] ?? 0) + 1
        stamps[key(feed, id)] = next
        return next
    }

    /// Applies `mutate` only while this model belongs to a live store AND `stamp` is still the
    /// newest load of this feed+session.
    private func commit(_ feed: DetailFeed, _ id: String, _ stamp: Int, _ mutate: () -> Void) {
        guard alive else {
            Log.ui.debug("dropping a detail read for a store that went away")
            return
        }
        guard stamps[key(feed, id)] == stamp else {
            Log.ui.debug("dropping a superseded detail read")
            return
        }
        mutate()
    }

    private func set(_ feed: DetailFeed, _ id: String, _ mark: Mark) {
        switch (feed, mark) {
        case (.activity, .loading): activity[id] = .loading
        case (.diff, .loading): diff[id] = .loading
        case (.files, .loading): files[id] = .loading
        case (.git, .loading): git[id] = .loading
        case (.activity, .failed(let m)): activity[id] = .failed(m)
        case (.diff, .failed(let m)): diff[id] = .failed(m)
        case (.files, .failed(let m)): files[id] = .failed(m)
        case (.git, .failed(let m)): git[id] = .failed(m)
        }
    }
}
