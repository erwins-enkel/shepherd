import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit

@MainActor
final class IOSVisibleActivityRecovery {
    private weak var app: AppModel?
    private weak var detail: DetailModel?
    private weak var store: SessionStore?
    private let selectedID: () -> String?
    private var pending: Task<Void, Never>?

    init(app: AppModel, detail: DetailModel, selectedID: @escaping () -> String?) {
        self.app = app
        self.detail = detail
        self.selectedID = selectedID
    }
    func storeDidChange(to store: SessionStore?) {
        guard self.store !== store else { return }
        pending?.cancel()
        pending = nil
        self.store = store
    }
    func reloadVisibleActivityIfNeeded() async {
        if let pending { await pending.value; return }
        guard let app, let detail, let store, let id = selectedID(),
            app.store === store, app.extension(DetailModel.self) === detail else { return }
        let generation = app.activationGeneration
        let work = Task { [weak self] in
            guard let self, self.selectedID() == id, app.activationGeneration == generation else { return }
            // An event-driven read already in flight owns this recovery. Wait for it to
            // settle; if it fails, the live transition must still trigger a retry.
            while detail.activity[id]?.isLoading == true || detail.isRefreshing(.activity, session: id) {
                let (changes, signal) = AsyncStream<Void>.makeStream()
                withObservationTracking {
                    _ = detail.activity[id]
                    _ = detail.isRefreshing(.activity, session: id)
                } onChange: { signal.yield(); signal.finish() }
                await withTaskCancellationHandler {
                    for await _ in changes { break }
                } onCancel: { signal.finish() }
                await Task.yield()
                guard !Task.isCancelled, app.activationGeneration == generation, self.selectedID() == id else { return }
                if detail.activity[id]?.value != nil { return }
            }
            guard !Task.isCancelled, app.store === store, app.activationGeneration == generation,
                  self.selectedID() == id, detail.isActive else { return }
            await detail.load(.activity, session: id)
        }
        pending = work
        await work.value
        pending = nil
    }
}
