import Observation
import ShepherdAppCore
import ShepherdKit

/// Retain iOS reply outcomes and drafts across detail navigation, scoped to a store.
@MainActor
final class IOSTerminalController: AppExtension {
    private let store: SessionStore
    private weak var app: AppModel?
    private let allowsInput: Bool
    private var models: [String: IOSTerminalPresentation] = [:]
    private var pruneWatcher: Task<Void, Never>?

    required init(store: SessionStore, app: AppModel) {
        self.store = store
        self.app = app
        allowsInput = app.allowsTerminalInput
        pruneWatcher = Task { [weak self, store] in
            while !Task.isCancelled {
                var ids = Set(store.sessions.map(\.id))
                // Done sessions are absent from the live store. Keep the selected
                // archive mounted until navigation leaves it.
                if let selected = self?.app?.selectedSessionID { ids.insert(selected) }
                self?.prune(keeping: ids)
                let (changes, sink) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
                withObservationTracking {
                    _ = store.sessions
                    _ = self?.app?.selectedSessionID
                } onChange: {
                    sink.yield(())
                    sink.finish()
                }
                for await _ in changes { break }
                await Task.yield()
            }
        }
    }

    func model(for sessionID: String) -> IOSTerminalPresentation {
        if let existing = models[sessionID] { return existing }
        let client = store.client
        // iOS owns pruning, including the selected archive. A second controller
        // pruning against only live sessions would detach that archive's PTY.
        let terminal = TerminalSessionModel(sessionID: sessionID, store: store, allowsInput: allowsInput,
            recovery: app?.extension(BackendRecoveryModel.self))
        let model = IOSTerminalPresentation(session: terminal, allowsInput: allowsInput,
            reply: { text in try await client.replySession(id: sessionID, text: text) })
        models[sessionID] = model
        return model
    }

    private func prune(keeping ids: Set<String>) {
        for id in models.keys.filter({ !ids.contains($0) }) {
            models[id]?.rendererUnmounted()
            models.removeValue(forKey: id)
        }
    }

    func teardown() {
        pruneWatcher?.cancel()
        pruneWatcher = nil
        for model in models.values { model.rendererUnmounted() }
        models = [:]
    }
}
