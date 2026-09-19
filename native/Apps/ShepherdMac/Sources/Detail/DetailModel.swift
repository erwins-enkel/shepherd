import Foundation
import Observation
import ShepherdKit

/// Where one tab's data stands. `failed` carries copy that has already been through
/// `ShepherdErrorCopy`, so a view never maps an error itself.
///
/// There is no `idle` case: a session that has never been loaded simply has no dictionary entry,
/// and every call site that needs a non-optional default falls back to `.loading` — the same
/// thing an absent entry and an in-flight first load look like to the operator.
enum Loaded<Value: Equatable & Sendable>: Equatable, Sendable {
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
    /// How many reads are in flight for a feed+session that already has a `.ready` value on
    /// screen — a poll tick, a push-driven reload, or a manual Refresh pressed while content is
    /// showing. `@Observable`-tracked (unlike `stamps`/`alive`) so a tab can dim a Refresh button
    /// or show a "still current as of…" hint without blanking what `Loaded` already holds. Never
    /// the reason a view chooses `.loading`: only `hasReadyValue(_:_:)` decides that, at the start
    /// of `load`.
    ///
    /// A count, not a set of keys: a poll tick and a manual Refresh overlap routinely, and the
    /// one that finishes first must not clear the mark out from under the one still running —
    /// which is exactly what a shared flag did, re-enabling the Refresh button mid-read.
    private(set) var refreshCounts: [String: Int] = [:]

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
    /// Watches `store.sessions` so a session that drops out of it (archived, removed, or simply
    /// never seen again after a reconnect) has its caches pruned instead of growing forever.
    @ObservationIgnored private var sessionsWatcher: Task<Void, Never>?
    /// Feed+session keys a push-driven reload is currently running for — at most one HTTP read
    /// per key even when several frames arrive before the first read returns.
    @ObservationIgnored private var pushInFlight: Set<String> = []
    /// A key whose in-flight push read got another frame while it was running: re-read exactly
    /// once more after the current read finishes, rather than once per extra frame.
    @ObservationIgnored private var pushPending: Set<String> = []

    init(store: SessionStore, app: AppModel) {
        self.loaders = .live(store.client)
        subscribe(store)
        watchSessions(store)
    }

    /// Test initialiser: the same model with hand-driven reads and no event tap — tests drive
    /// `load`/`poll` directly instead of pushing frames through a store.
    init(loaders: Loaders) { self.loaders = loaders }

    func teardown() {
        alive = false
        watcher?.cancel()
        watcher = nil
        sessionsWatcher?.cancel()
        sessionsWatcher = nil
    }

    /// Reads one feed for one session. Safe to call while a read is already in flight.
    ///
    /// The first read for a session shows `.loading`; a read that lands on top of a `.ready`
    /// value instead keeps that value on screen and counts the read in `refreshCounts`, so a
    /// poll tick or a push never blanks content the operator is looking at. A cancelled read
    /// writes nothing to either cache — it is the app walking away from its own call, not a
    /// failure to report — and a background refresh that fails for real keeps the last good
    /// value rather than replacing it with an error.
    func load(_ feed: DetailFeed, session id: String) async {
        let stamp = nextStamp(feed, id)
        let firstLoad = !hasReadyValue(feed, id)
        let refreshKey = key(feed, id)
        if firstLoad {
            set(feed, id, .loading)
        } else {
            beginRefresh(refreshKey)
        }
        // Balanced here rather than inside `commit`, so this read clears exactly the mark it put
        // there — a superseded, failed or cancelled read included.
        defer { if !firstLoad { endRefresh(refreshKey) } }
        do {
            switch feed {
            case .activity:
                let entries = try await loaders.activity(id)
                commit(feed, id, stamp) { self.activity[id] = .ready(entries) }
            case .diff:
                let result = try await loaders.diff(id)
                let previous = diff[id]?.value
                // Re-reading the annotations on every 15 s tick is wasted work once the diff
                // itself has not moved: `head` is the branch's current commit, so an unchanged
                // `head` means an unchanged diff, and the previous notes are still correct.
                var notes = previous?.notes ?? []
                if previous == nil || previous?.result.head != result.head {
                    do { notes = try await loaders.annotations(id) } catch {
                        if isCancellation(error) { throw error }
                        Log.ui.debug("diff annotations failed; keeping the diff")
                        notes = previous?.notes ?? []
                    }
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
            if isCancellation(error) {
                // No cache write: cancelling the task that made this call is not a server,
                // network or contract failure, so there is nothing to show for it. The `defer`
                // above still balances this read's own refresh mark.
                return
            }
            let copy = ShepherdErrorCopy.message(error)
            commit(feed, id, stamp) {
                if firstLoad {
                    self.set(feed, id, .failed(copy))
                } else {
                    Log.ui.debug("a background refresh failed; keeping the last good value")
                }
            }
        }
    }

    /// Lists one directory of one files source, replacing whatever the files tab held. Always
    /// shows `.loading`, unlike `load(_:session:)`: this is the operator navigating to different
    /// content, not a background refresh of the content already on screen.
    func browse(session id: String, source: FilesSource, path: String?) async {
        let stamp = nextStamp(.files, id)
        let previous = files[id]
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
            if isCancellation(error) {
                // Unlike `load`, nothing re-runs this: a browse is the operator navigating, and
                // there is no `.task(id:)` to heal a `.loading` that never resolves. Put back
                // whatever the tab was showing — `nil` means "never loaded", so the next visit
                // starts over rather than inheriting a spinner.
                commit(.files, id, stamp) { self.files[id] = previous }
                return
            }
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

    /// Whether `feed`+`id` has a value already on screen and is quietly re-reading it. A tab uses
    /// this to dim a Refresh control or show a subtler "updating" hint instead of the loading
    /// chrome `Loaded.loading` drives — that chrome is reserved for the first read of a session.
    func isRefreshing(_ feed: DetailFeed, session id: String) -> Bool {
        (refreshCounts[key(feed, id)] ?? 0) > 0
    }

    /// Keeps `activity`/`git` current without a timer. `session:activity`/`session:git` are
    /// declared under this stream's own `x-shepherd-events` block but never added to `EventName`
    /// (Decision 3), so they arrive through `store.events()` as
    /// `ServerEvent.unknown(name:payload:)`: match the raw name, decode `payload` into the schema
    /// this stream's own contract block names, and schedule a reload for exactly the session id
    /// the frame carries — never every open tab, and never a session this model has no cache
    /// entry for, since nobody has opened that tab to read the result. `schedulePushLoad(_:session:)`
    /// coalesces a burst of frames for the same feed+session into at most one HTTP read at a
    /// time; `load(_:session:)`'s own `commit(_:_:_:_:)` already drops a write once `alive` is
    /// false, so this loop needs no liveness check beyond `weak self`, and it ends on its own once
    /// `store.events()` finishes on `stop()`, or sooner if `teardown()` cancels it directly.
    private func subscribe(_ store: SessionStore) {
        watcher = Task { @MainActor [weak self] in
            for await event in store.events() {
                guard let self else { return }
                guard case .unknown(let name, let payload) = event, let payload else { continue }
                switch name {
                case Self.activityEventName:
                    guard
                        let decoded = try? JSONDecoder().decode(
                            SessionActivityEvent.self, from: payload)
                    else { continue }
                    self.schedulePushLoad(.activity, session: decoded.id)
                case Self.gitEventName:
                    guard
                        let decoded = try? JSONDecoder().decode(SessionGitEvent.self, from: payload)
                    else { continue }
                    self.schedulePushLoad(.git, session: decoded.id)
                default:
                    continue
                }
            }
        }
    }

    /// Prunes caches for sessions the store no longer lists, so a long-running window does not
    /// grow the four caches (and their bookkeeping) without bound. Reads `store.sessions`
    /// up front, then re-arms on every subsequent write through `withObservationTracking`,
    /// mirroring `AppModel.watchConnection(_:profile:generation:)`.
    private func watchSessions(_ store: SessionStore) {
        sessionsWatcher = Task { @MainActor [weak self] in
            guard let self else { return }
            var known = Set(store.sessions.map(\.id))
            self.prune(activeIDs: known)
            while !Task.isCancelled {
                await withCheckedContinuation { continuation in
                    withObservationTracking {
                        _ = store.sessions
                    } onChange: {
                        continuation.resume()
                    }
                }
                guard !Task.isCancelled else { return }
                await Task.yield()
                let ids = Set(store.sessions.map(\.id))
                guard ids != known else { continue }
                known = ids
                self.prune(activeIDs: known)
            }
        }
    }

    // MARK: - Internals

    /// The two states that carry no value. A single `Loaded` value cannot be written into four
    /// differently-typed dictionaries, so this carries the intent instead.
    private enum Mark { case loading, failed(String) }

    private static let activityEventName = "session:activity"
    private static let gitEventName = "session:git"

    private func key(_ feed: DetailFeed, _ id: String) -> String { "\(feed.rawValue):\(id)" }

    /// The session id half of a `key(_:_:)` string, for pruning the flat `String` sets that key
    /// carries no `DetailFeed` of its own to switch on.
    private func sessionID(fromKey composite: String) -> String {
        guard let colon = composite.firstIndex(of: ":") else { return composite }
        return String(composite[composite.index(after: colon)...])
    }

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

    /// Whether `feed`+`id` already holds a `.ready` value — the line between a session's first
    /// read (shows `Loaded.loading`) and a background refresh of what is already on screen
    /// (counted in `refreshCounts` instead). A previous `.failed` counts as "no ready value": a
    /// retry after a failure has nothing to keep showing, so it gets the loading chrome again.
    private func hasReadyValue(_ feed: DetailFeed, _ id: String) -> Bool {
        switch feed {
        case .activity:
            guard let entry = activity[id], case .ready = entry else { return false }
            return true
        case .diff:
            guard let entry = diff[id], case .ready = entry else { return false }
            return true
        case .files:
            guard let entry = files[id], case .ready = entry else { return false }
            return true
        case .git:
            guard let entry = git[id], case .ready = entry else { return false }
            return true
        }
    }

    /// Whether `feed`+`id` has any dictionary entry at all — loading, ready or failed. A push
    /// frame for a session with none is a session no open tab has ever read, so there is nothing
    /// for the reload to update and the push is dropped rather than firing a read nobody watches.
    private func hasCacheEntry(_ feed: DetailFeed, _ id: String) -> Bool {
        switch feed {
        case .activity: return activity[id] != nil
        case .diff: return diff[id] != nil
        case .files: return files[id] != nil
        case .git: return git[id] != nil
        }
    }

    /// Turns a push frame into a `load(_:session:)` call, coalescing a burst of frames for the
    /// same feed+session into at most one HTTP read running at a time plus at most one queued
    /// follow-up — never one read per frame. Internal, not private, so a test can drive the
    /// coalescing directly without standing up a live `SessionStore` and `EventStream`.
    func schedulePushLoad(_ feed: DetailFeed, session id: String) {
        guard hasCacheEntry(feed, id) else { return }
        let k = key(feed, id)
        guard !pushInFlight.contains(k) else {
            pushPending.insert(k)
            return
        }
        pushInFlight.insert(k)
        Task { [weak self] in await self?.runPushLoad(feed, id) }
    }

    /// Runs the read this push asked for, then drains whatever queued behind it — iteratively,
    /// never by calling itself: a session that streams frames for hours would otherwise grow the
    /// call chain by one frame per queued follow-up.
    private func runPushLoad(_ feed: DetailFeed, _ id: String) async {
        let k = key(feed, id)
        await load(feed, session: id)
        while alive, pushPending.remove(k) != nil {
            await load(feed, session: id)
        }
        pushInFlight.remove(k)
        pushPending.remove(k)
    }

    /// Drops cache, stamp and bookkeeping entries for sessions no longer in `activeIDs`.
    /// Internal, not private, so a test can drive it directly without standing up a live
    /// `SessionStore` and waiting on `withObservationTracking`.
    func prune(activeIDs: Set<String>) {
        activity = activity.filter { activeIDs.contains($0.key) }
        diff = diff.filter { activeIDs.contains($0.key) }
        files = files.filter { activeIDs.contains($0.key) }
        git = git.filter { activeIDs.contains($0.key) }
        stamps = stamps.filter { activeIDs.contains(sessionID(fromKey: $0.key)) }
        refreshCounts = refreshCounts.filter { activeIDs.contains(sessionID(fromKey: $0.key)) }
        pushInFlight = pushInFlight.filter { activeIDs.contains(sessionID(fromKey: $0)) }
        pushPending = pushPending.filter { activeIDs.contains(sessionID(fromKey: $0)) }
    }

    private func beginRefresh(_ refreshKey: String) {
        refreshCounts[refreshKey, default: 0] += 1
    }

    /// Clamped at zero and removed when it gets there, so a `prune(activeIDs:)` that dropped the
    /// entry while a read was still running cannot leave a negative count behind.
    private func endRefresh(_ refreshKey: String) {
        guard let count = refreshCounts[refreshKey] else { return }
        if count <= 1 {
            refreshCounts.removeValue(forKey: refreshKey)
        } else {
            refreshCounts[refreshKey] = count - 1
        }
    }

    private func isCancellation(_ error: any Error) -> Bool {
        if error is CancellationError { return true }
        if let shepherd = error as? ShepherdError, shepherd == .cancelled { return true }
        return false
    }
}
