import Observation
import ShepherdKit

/// Per-store terminal state: one `TerminalSessionModel` per session id.
///
/// An `AppExtension`, so `AppModel` creates it after the store exists and tears
/// it down with the store. A model therefore never outlives the client it
/// attached with, which is what makes the generation guard inside the model
/// sufficient.
@Observable
@MainActor
final class TerminalController: AppExtension {
    private let store: SessionStore
    /// `@ObservationIgnored`: `TerminalTab.makeView` mutates this via
    /// `model(for:)` from inside a view's own body evaluation (`makeView` runs
    /// as the detail tab renders), and a tracked property mutated there would
    /// re-trigger the very update that is mutating it. Nothing observes the
    /// dictionary itself — callers read through `model(for:)`, and each
    /// `TerminalSessionModel` is its own `@Observable`.
    @ObservationIgnored
    private var models: [String: TerminalSessionModel] = [:]
    /// Re-arms on every `store.sessions` mutation and prunes models for
    /// sessions that no longer exist. `@ObservationIgnored`: plumbing, not
    /// state anything renders.
    @ObservationIgnored
    private var pruneWatcher: Task<Void, Never>?

    required init(store: SessionStore, app: AppModel) {
        self.store = store
        pruneWatcher = TerminalController.watchSessions(store) { [weak self] ids in
            self?.prune(keeping: ids)
        }
    }

    /// The model for a session, created on first use. Terminals are cheap when
    /// idle (no socket until `attach`), and keeping them means switching away
    /// and back does not lose the prompt draft — or the verdict the terminal
    /// was parked on.
    func model(for sessionID: String) -> TerminalSessionModel {
        if let existing = models[sessionID] { return existing }
        let model = TerminalSessionModel(sessionID: sessionID, store: store)
        models[sessionID] = model
        return model
    }

    /// Tears down models for sessions no longer in `ids` — a deleted, merged
    /// or expired session must not keep its socket, prompt draft or parked
    /// verdict alive for the rest of the app's run.
    func prune(keeping ids: Set<String>) {
        let stale = models.keys.filter { !ids.contains($0) }
        for sessionID in stale {
            models[sessionID]?.detach()
            models.removeValue(forKey: sessionID)
        }
    }

    func teardown() {
        pruneWatcher?.cancel()
        for model in models.values { model.detach() }
        models = [:]
    }

    /// Mirrors `AppModel.watchConnection`'s read-then-arm loop: read and
    /// compare *before* arming `withObservationTracking`, so a mutation that
    /// lands between this call and the loop's first pass is not missed —
    /// observation only reports the *next* write after it is armed. Re-arms
    /// on every subsequent change, forever, until `pruneWatcher.cancel()`.
    ///
    /// Internal rather than private only so a test can prove that
    /// `cancel()` really ends the returned task.
    static func watchSessions(
        _ store: SessionStore, onChange: @escaping @MainActor (Set<String>) -> Void
    ) -> Task<Void, Never> {
        Task { @MainActor in
            var current: Set<String>?
            while !Task.isCancelled {
                let ids = Set(store.sessions.map(\.id))
                if ids != current {
                    current = ids
                    onChange(ids)
                    continue
                }
                await sessionsChanged(store)
                if Task.isCancelled { return }
                // `onChange` runs just before the property is written; yield
                // once so the writer finishes before the next pass reads it.
                await Task.yield()
            }
        }
    }

    /// Suspends until `store.sessions` is written — **or** until the calling
    /// task is cancelled.
    ///
    /// That second exit is the whole point. A bare `withCheckedContinuation`
    /// wrapped around `withObservationTracking` has only one way out:
    /// `onChange`, which fires on the *next* write. After `teardown()` nothing
    /// writes that store again, so the continuation is never resumed, the
    /// watcher task stays suspended for the life of the process, and it keeps
    /// the store — and the `ShepherdClient` behind it — alive. One more
    /// retained store per server switch.
    ///
    /// `AsyncStream`'s iterator is cancellation-aware (a cancelled task gets
    /// `nil` rather than parking), so handing the observation callback a
    /// continuation of that stream gives cancellation its own way out without
    /// a second resume racing the first — resuming a checked continuation
    /// twice traps.
    ///
    /// NOTE: `AppModel.watchConnection` has the same read-then-arm shape and
    /// the same leak. It belongs to the integration lane (S0), so this stream
    /// deliberately leaves it alone — see this PR's handoff list.
    private static func sessionsChanged(_ store: SessionStore) async {
        let (changes, sink) = AsyncStream<Void>.makeStream(
            bufferingPolicy: .bufferingNewest(1))
        withObservationTracking {
            _ = store.sessions
        } onChange: {
            sink.yield(())
            sink.finish()
        }
        for await _ in changes { break }
    }
}
