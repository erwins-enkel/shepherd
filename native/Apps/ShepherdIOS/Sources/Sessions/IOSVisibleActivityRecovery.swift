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
    private let isCurrent: () -> Bool
    private var pending: Task<Void, Never>?
    private var revision = 0

    init(app: AppModel, detail: DetailModel, selectedID: @escaping () -> String?) {
        self.app = app
        self.detail = detail
        self.selectedID = selectedID
        self.isCurrent = { [weak app, weak detail] in
            guard let app, let detail else { return false }
            return app.extension(DetailModel.self) === detail && app.store != nil
        }
    }
    /// A narrow state seam: tests exercise real DetailModel loads without a socket.
    init(detail: DetailModel, selectedID: @escaping () -> String?, isCurrent: @escaping () -> Bool) {
        self.detail = detail
        self.selectedID = selectedID
        self.isCurrent = isCurrent
    }
    func cancelVisibleWork() {
        revision &+= 1
        pending?.cancel()
        pending = nil
    }
    func storeDidChange(to store: SessionStore?) {
        guard self.store !== store else { return }
        cancelVisibleWork()
        self.store = store
    }
    func reloadVisibleActivityIfNeeded() async {
        if let pending { await pending.value; return }
        guard let detail, let id = selectedID(), isCurrent(),
            app == nil || app?.store === store else { return }
        let generation = app?.activationGeneration
        let revision = revision
        let work = Task { [weak self] in
            guard let self, self.selectedID() == id, self.app?.activationGeneration == generation else { return }
            // Wait for an event-driven read before one coalesced recovery read.
            // A failed background read can preserve .ready, so it cannot prove freshness.
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
                guard !Task.isCancelled, self.app?.activationGeneration == generation, self.selectedID() == id else { return }
            }
            guard !Task.isCancelled, self.isCurrent(), self.app?.activationGeneration == generation,
                  self.selectedID() == id, detail.isActive else { return }
            await detail.load(.activity, session: id)
        }
        pending = work
        await work.value
        if revision == self.revision { pending = nil }
    }
}
