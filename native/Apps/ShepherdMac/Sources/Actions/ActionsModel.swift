import Foundation
import Observation
import ShepherdKit

/// The one read the action bar bootstraps from, behind a closure so the unit tests need no
/// network and no URL-protocol stub.
struct ActionReads: Sendable {
    var recaps: @Sendable () async throws -> [String: Recap]

    static func live(_ client: ShepherdClient) -> ActionReads {
        ActionReads(recaps: { try await client.recaps() })
    }
}

/// The action bar's state: the recap line's source, the amendment counts, and the two seams
/// that belong to other streams.
///
/// An `AppExtension`, so it is built in `AppModel.activate(_:)` once the store exists and torn
/// down right before that store stops. It holds its store strongly, which is safe precisely
/// because of that lifecycle.
///
/// Everything it shows is re-derivable: `refresh()` re-reads the whole recap map, and the two
/// frames it taps each carry a complete replacement for one session. That is deliberate — a tap
/// is not a guaranteed-complete log (it drops its own oldest past 64 buffered, and `EventStream`
/// loses frames while a socket is down), so nothing here may depend on an unbroken sequence.
@Observable
@MainActor
final class ActionsModel: AppExtension {
    private(set) var recaps: [String: Recap] = [:]
    private(set) var amendments: [String: [TaskAmendment]] = [:]

    /// S3's `GET /api/working-blocked`. Empty until the integration lane assigns it; empty is
    /// the conservative answer (a blocked session reads as blocked, so Stop stays hidden).
    var workingBlocked: [String: Bool] = [:]
    /// Session ids whose PR has merged — S2's `GET /api/sessions/{id}/git`. Empty until the
    /// integration lane assigns it; empty means Relaunch stays offered, matching the web's
    /// behaviour before its own git snapshot arrives.
    var gitMerged: Set<String> = []

    /// Whether the event tap is still running. Read by the tests; `teardown()` clears it.
    private(set) var isSubscribed = false

    var reads: ActionReads
    private let now: @Sendable () -> Int
    private weak var app: AppModel?
    /// Held strongly for the extension's lifetime — see the type comment — and released in
    /// `teardown()`. Read only for the live session list the caches are pruned to; every
    /// command goes through `store.client`, never through the store's own state.
    @ObservationIgnored private var store: SessionStore?

    /// Drops a snapshot whose **read** has been superseded. Bumped by `teardown()`, and compared
    /// across every `await` in `refresh()`.
    ///
    /// Deliberately not what the tap and the connection watcher check: a read losing its race is
    /// a routine, recoverable thing, and using one counter for both meant a stale read silently
    /// killed a perfectly live event tap. Teardown is a separate, one-way fact — `isTornDown`.
    @ObservationIgnored private var generation = 0
    /// One-way: set by `teardown()` and never cleared, because an extension is never revived.
    /// The tap and the connection watcher check this rather than `generation`.
    @ObservationIgnored private var isTornDown = false
    @ObservationIgnored private var tap: Task<Void, Never>?
    /// The one-shot read `init(store:app:)` kicks off. Held so `teardown()` can cancel it
    /// rather than relying on the generation guard alone.
    @ObservationIgnored private var bootstrap: Task<Void, Never>?
    /// The reconcile loop. Cancelled in `teardown()`.
    @ObservationIgnored private var connectionWatcher: Task<Void, Never>?

    /// Where the reconcile loop reads the connection state from. Production hands it a **weak**
    /// view of the store, so the watcher can never be the reason a dropped store — and the
    /// socket behind it — stays alive; the tests hand it a `ConnectionBox` they flip by hand,
    /// which is the only way a reconnect can be exercised without a server. Same seam
    /// `AppModel`'s own watcher uses, not a second one.
    @ObservationIgnored var connectionSource: ConnectionSource?

    init(store: SessionStore, app: AppModel) {
        self.reads = .live(store.client)
        self.now = { Int(Date().timeIntervalSince1970 * 1_000) }
        self.app = app
        self.store = store
        self.connectionSource = ConnectionSource(
            read: { [weak store] in store?.connection }, abandon: {})
        subscribe(to: store)
        watchConnection()
        bootstrap = Task { [weak self] in await self?.refresh() }
    }

    /// Test/preview seam: no store, no socket, injected clock.
    init(reads: ActionReads, now: @escaping @Sendable () -> Int) {
        self.reads = reads
        self.now = now
    }

    // MARK: - Reads

    func recap(for id: String) -> Recap? { recaps[id] }
    func amendments(for id: String) -> [TaskAmendment] { amendments[id] ?? [] }

    func actions(for session: Session) -> [SessionAction] {
        ActionRules.available(
            for: session,
            workingBlocked: workingBlocked,
            gitMerged: gitMerged.contains(session.id),
            now: now())
    }

    /// Re-reads the recap snapshot. A failure is logged and dropped: the bar keeps the last
    /// snapshot rather than blanking, because a missing recap line reads as "nothing to do".
    func refresh() async {
        let mine = generation
        do {
            let loaded = try await reads.recaps()
            guard mine == generation else { return }
            recaps = loaded
            pruneToLiveSessions()
        } catch {
            // A cancelled read is this model walking away from its own call — `teardown()`
            // cancels the bootstrap — so it is a debug line, not an error the operator or a
            // bug report should ever see framed as a failure.
            if Self.isCancellation(error) {
                Log.ui.debug("recap snapshot read cancelled")
            } else {
                Log.ui.error(
                    "recap snapshot read failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// Both spellings of "the caller walked away": Swift's own, and the one the kit maps a
    /// cancelled `URLSession` task to.
    private static func isCancellation(_ error: any Error) -> Bool {
        if error is CancellationError { return true }
        if let shepherd = error as? ShepherdError, case .cancelled = shepherd { return true }
        return false
    }

    /// Drops the derived state of sessions the store no longer lists, so neither cache grows
    /// with everything this process has ever seen. Both are re-derivable: a recap comes back
    /// with the next snapshot, an amendment list with the next frame for that session.
    func prune(to live: Set<String>) {
        recaps = recaps.filter { live.contains($0.key) }
        amendments = amendments.filter { live.contains($0.key) }
    }

    /// An empty session list is skipped rather than obeyed: it is indistinguishable from a store
    /// whose own bootstrap has not landed yet, and the bootstrap refresh here races that one by
    /// construction. Not pruning then costs nothing — whatever the caches hold is already
    /// bounded by what arrived before the first session did.
    private func pruneToLiveSessions() {
        guard let store, !store.sessions.isEmpty else { return }
        prune(to: Set(store.sessions.map(\.id)))
    }

    #if DEBUG
        /// Tests only: make the next in-flight refresh look superseded, by moving the generation
        /// on *while* the read is in flight — which is the only way a real refresh loses its
        /// race. Wrapping `reads` rather than branching inside `refresh()` keeps the seam out of
        /// the production path entirely, and `#if DEBUG` keeps it out of the shipped binary, the
        /// way `PreviewData` is kept out.
        func armStaleGeneration() {
            let inner = reads.recaps
            reads = ActionReads(recaps: { [weak self] in
                let loaded = try await inner()
                await MainActor.run { self?.generation &+= 1 }
                return loaded
            })
        }
    #endif

    // MARK: - Reconciling after a drop

    /// Re-reads the recap snapshot every time the socket comes back.
    ///
    /// `native/README.md`, "Reconcile after a drop": events are not a guaranteed-complete log —
    /// `EventStream` loses frames while the socket is down, and each tap drops its own oldest
    /// past 64 — so nothing here may depend on an unbroken sequence. Without this the bootstrap
    /// read was the *only* read this model ever did: a recap regenerated during an outage never
    /// arrived, and `prune(to:)` kept no-opping because the store's own session list was still
    /// empty when the one refresh ran.
    ///
    /// Only a transition **into** `.live` refreshes. `.connecting` is published on every retry,
    /// and refreshing then would be a read against a server the store itself cannot reach.
    ///
    /// Cancellation-aware and weak throughout: the loop holds neither the model nor the store,
    /// and `teardown()` both cancels it and sets `isTornDown`, which the pass after the
    /// suspension checks. It checks `isTornDown` rather than `generation` on purpose — a read
    /// that lost its race must not take the reconcile loop down with it.
    func watchConnection() {
        guard let source = connectionSource, var current = source.read() else { return }
        // Re-arming replaces the loop rather than racing a second one against it — which is what
        // a test that swaps `connectionSource` for a hand-driven box does.
        connectionWatcher?.cancel()
        connectionWatcher = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                var moved = false
                // Read *before* arming, in its own scope. Before: because the state can move
                // between `watchConnection()` and this task's first run — observation only ever
                // reports the *next* write, so a transition in that window would be waited out
                // forever. In its own scope: a `self` still bound across the suspension below
                // would make this watcher the reason a dropped model never deinits.
                do {
                    guard let self, !self.isTornDown else { return }
                    // `nil` means the store behind the source is gone; there is nothing left to
                    // reconcile against, and arming an observation on it would park this task
                    // on a continuation no write can resume.
                    guard let latest = source.read() else { return }
                    if latest != current {
                        let wasLive = current == .live
                        current = latest
                        moved = true
                        // The one strong hold on the model in this loop, for the length of one
                        // bounded read.
                        if latest == .live, !wasLive { await self.refresh() }
                    }
                }
                if moved { continue }

                // `withObservationTracking` fires `onChange` exactly once, so the registration
                // is renewed on every pass. `onChange` runs just *before* the write lands, hence
                // the yield before the next pass reads it.
                await withCheckedContinuation { continuation in
                    withObservationTracking {
                        _ = source.read()
                    } onChange: {
                        continuation.resume()
                    }
                }
                await Task.yield()
            }
        }
    }

    // MARK: - Events

    private func subscribe(to store: SessionStore) {
        isSubscribed = true
        let events = store.events()
        tap = Task { [weak self] in
            // `defer`, not a line after the loop: the guard below returns out of the middle of
            // the loop, and that path has to clear the flag too or a torn-down model keeps
            // claiming a tap it no longer has.
            defer { self?.isSubscribed = false }
            // `tap?.cancel()` alone is not enough: a cancelled `AsyncStream` iterator still
            // hands back an element that was already buffered — it returns `nil` only when it
            // has to suspend — so a frame the store yielded around teardown can arrive
            // afterwards and mutate an extension whose store is gone. `isTornDown` is set
            // synchronously on the main actor by `teardown()`, so this cannot race it.
            for await event in events {
                guard let self, !self.isTornDown else { return }
                self.apply(event)
            }
        }
    }

    /// Applies one frame. Both of this stream's events arrive as `.unknown(name:payload:)` —
    /// `EventName` is an open enum and `ServerEvent.swift` is S0-owned, so a stream decodes its
    /// own payload with the generated schema its own contract block declares.
    func apply(_ event: ServerEvent) {
        switch event {
        case .sessionArchived(let payload):
            recaps[payload.id] = nil
            amendments[payload.id] = nil
        case .unknown(let name, let payload):
            guard let payload else { return }
            switch name {
            case "session:recap":
                guard let frame = decode(Components.Schemas.SessionRecapEvent.self, payload, name)
                else { return }
                recaps[frame.id] = frame.recap
            case "session:amendments":
                guard
                    let frame = decode(
                        Components.Schemas.SessionAmendmentsEvent.self, payload, name)
                else { return }
                // The server always sends the FULL current list, so an empty array is a genuine
                // all-clear and must replace, not merge.
                amendments[frame.id] = frame.amendments
            default:
                return
            }
        default:
            return
        }
    }

    /// A frame this build cannot read is dropped, never fatal: the server emits shapes a newer
    /// Shepherd may have widened, and one bad frame must not take the bar down.
    /// Names the frame and says why it would not read: "dropping an undecodable actions frame"
    /// on its own is unactionable, and a widened server shape is exactly the thing somebody has
    /// to be able to diagnose from a log.
    private func decode<T: Decodable>(_ type: T.Type, _ data: Data, _ name: String) -> T? {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            Log.ui.debug(
                """
                dropping an undecodable \(name, privacy: .public) frame: \
                \(String(describing: error), privacy: .public)
                """)
            return nil
        }
    }

    // MARK: - Lifecycle

    func teardown() {
        isTornDown = true
        generation &+= 1
        tap?.cancel()
        tap = nil
        bootstrap?.cancel()
        bootstrap = nil
        connectionWatcher?.cancel()
        connectionWatcher = nil
        connectionSource = nil
        isSubscribed = false
        store = nil
        app = nil
    }
}

extension ActionReads {
    /// A fixed snapshot for the unit tests and previews.
    static let stub = ActionReads(recaps: {
        [
            "s1": Recap(
                sessionId: "s1",
                state: RecapState(known: .ready),
                verdict: RecapVerdict(known: .needsAttention),
                headline: "Rate limiter lands",
                body: "Adds the token bucket and its tests.",
                openItems: ["wire the admin route through the limiter"],
                changedFiles: ["src/limiter.ts"],
                generatedAt: 1_800_000_060_000,
                updatedAt: 1_800_000_060_000)
        ]
    })

    /// Every read throws, for the "a failure must not blank the bar" test.
    static let failing = ActionReads(recaps: { throw ShepherdError.transport("stub") })
}
