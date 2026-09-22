import Observation
import ShepherdKit

/// S7's sole integration point. Install after SidebarInstall, NotificationsStream, and
/// SessionSignals.connect: connect still assigns S2's sparse git cache to gitMerged.
@MainActor
enum HerdStream {
    static func install(_ app: AppModel) {
        app.register(HerdSignals.self)
        app.register(HerdBindings.self)
        connect(app)
    }

    fileprivate static func connect(_ app: AppModel) {
        // These closures survive their extension's activation; always resolve the current herd.
        if let sidebar = app.extension(SidebarModel.self) {
            sidebar.gitStage = { [weak app] session in
                // The full candidate is idempotent with HerdPartition's own terminal rules.
                app?.extension(HerdSignals.self)?.stage(for: session)
            }
            sidebar.inReview = { [weak app] session in
                guard let herd = app?.extension(HerdSignals.self) else { return false }
                return herd.isReviewing(session.id) || herd.planReviewing(session)
            }
        }
        if let herd = app.extension(HerdSignals.self) {
            herd.planReviewing = { session in PlanSignals.planReviewing(session.id) }
            herd.planRework = { [weak app] session in
                app?.extension(PlanModel.self)?.isReworking(session) ?? false
            }
        }
        SessionSignals.gitMerged = { [weak app] id in
            app?.extension(HerdSignals.self)?.git[id]?.state.known == .merged
        }
    }
}

/// AppModel rebuilds extensions without rerunning installers. Registered after HerdSignals and
/// its consumers, this binding restores the seams on every activation, including the first one
/// after an install with no store. It observes CI failures and unanswered plan questions without another event tap.
@MainActor
private final class HerdBindings: AppExtension {
    private var watcher: Task<Void, Never>?
    private let signal: AsyncStream<Void>.Continuation

    init(store: SessionStore, app: AppModel) {
        HerdStream.connect(app)
        let (changes, signal) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        self.signal = signal
        let generation = app.activationGeneration
        watcher = Task { @MainActor [weak app] in
            var iterator = changes.makeAsyncIterator()
            while !Task.isCancelled {
                // Release the app before parking. A buffered observation cannot cross an
                // activation boundary, even if cancellation has not been delivered yet.
                do {
                    guard let app, app.activationGeneration == generation else { return }
                    let ids = withObservationTracking {
                        let ci = app.extension(HerdSignals.self)?.ciRed ?? []
                        let plan = app.extension(PlanModel.self)
                        let questions = Set((plan?.gates.keys.map { $0 } ?? []).filter {
                            plan?.questionsUnanswered($0) == true
                        })
                        let owed = Set(app.extension(MergeModel.self)?.outstanding.keys.map { $0 } ?? [])
                        return ci.union(questions).union(owed)
                    } onChange: {
                        signal.yield()
                    }
                    // NotificationsModel intersects the combined attention set with live session ids.
                    app.extension(NotificationsModel.self)?.extraAttention = ids
                }
                guard await iterator.next() != nil else { return }
                // Observation fires before the property write; sample after it has committed.
                await Task.yield()
            }
        }
    }

    func teardown() {
        signal.finish()
        watcher?.cancel()
        watcher = nil
    }
}
