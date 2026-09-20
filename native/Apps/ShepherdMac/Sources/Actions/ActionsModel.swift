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

    /// Drops a snapshot whose activation has moved on. Bumped by `teardown()`, and compared
    /// across every `await`.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var tap: Task<Void, Never>?
    /// The one-shot read `init(store:app:)` kicks off. Held so `teardown()` can cancel it
    /// rather than relying on the generation guard alone.
    @ObservationIgnored private var bootstrap: Task<Void, Never>?

    init(store: SessionStore, app: AppModel) {
        self.reads = .live(store.client)
        self.now = { Int(Date().timeIntervalSince1970 * 1_000) }
        self.app = app
        self.store = store
        subscribe(to: store)
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
            Log.ui.error(
                "recap snapshot read failed: \(String(describing: error), privacy: .public)")
        }
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

    /// Tests only: make the next in-flight refresh look superseded, by moving the generation on
    /// *while* the read is in flight — which is the only way a real refresh loses its race.
    /// Wrapping `reads` rather than branching inside `refresh()` keeps the seam out of the
    /// production path entirely.
    func armStaleGeneration() {
        let inner = reads.recaps
        reads = ActionReads(recaps: { [weak self] in
            let loaded = try await inner()
            await MainActor.run { self?.generation &+= 1 }
            return loaded
        })
    }

    // MARK: - Events

    private func subscribe(to store: SessionStore) {
        isSubscribed = true
        let events = store.events()
        // The same generation that drops a superseded read drops a superseded frame.
        // `tap?.cancel()` alone is not enough: a cancelled `AsyncStream` iterator still hands
        // back an element that was already buffered — it returns `nil` only when it has to
        // suspend — so a frame the store yielded around teardown can arrive afterwards and
        // mutate an extension whose store is gone. This check is synchronous on the main actor,
        // so it cannot race the `teardown()` that bumped it.
        let mine = generation
        tap = Task { [weak self] in
            for await event in events {
                guard let self, mine == self.generation else { return }
                self.apply(event)
            }
            self?.isSubscribed = false
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
                guard let frame = decode(Components.Schemas.SessionRecapEvent.self, payload)
                else { return }
                recaps[frame.id] = frame.recap
            case "session:amendments":
                guard let frame = decode(Components.Schemas.SessionAmendmentsEvent.self, payload)
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
    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) -> T? {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            Log.ui.debug("dropping an undecodable actions frame")
            return nil
        }
    }

    // MARK: - Lifecycle

    func teardown() {
        generation &+= 1
        tap?.cancel()
        tap = nil
        bootstrap?.cancel()
        bootstrap = nil
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
