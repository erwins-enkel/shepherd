import Observation
import ShepherdAppCore
import ShepherdKit

/// Retain iOS reply outcomes and drafts across detail navigation, scoped to a store.
@MainActor
final class IOSTerminalController: AppExtension {
    private let store: SessionStore
    private weak var app: AppModel?
    private let allowsInput: Bool
    let whisperStatus: IOSWhisperStatus
    private var models: [String: IOSTerminalPresentation] = [:]
    private var pruneWatcher: Task<Void, Never>?

    required init(store: SessionStore, app: AppModel) {
        self.store = store
        self.app = app
        allowsInput = app.allowsTerminalInput
        whisperStatus = IOSWhisperStatus(read: { try await store.client.getVoiceStatus()?.available == true })
        pruneWatcher = Task { [weak self, store] in
            while !Task.isCancelled {
                var ids = Set(store.sessions.map(\.id))
                // Done sessions are absent from the live store. Keep the selected
                // archive mounted until navigation leaves it.
                if let selected = self?.app?.selectedSessionID { ids.insert(selected) }
                self?.prune(keeping: ids)
                for session in store.sessions { self?.models[session.id]?.serverSessionChanged(session.status) }
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
            actions: { [weak app, weak store] in
                guard let session = store?.session(id: sessionID) else { return nil }
                return app?.extension(IOSSessionActions.self)?.state(for: session)
            },
            dictation: { [weak app, weak store, whisperStatus] in
                guard let app, let store, app.store === store, app.allowsTerminalInput,
                      app.liveRequestAudit == nil else { return nil }
                let context = store.session(id: sessionID).map { [$0.repoPath, $0.baseBranch] } ?? []
                return IOSDictationSession(client: client, defaults: app.composerDefaults, context: context,
                    whisperStatus: whisperStatus, getText: { terminal.promptText }, setText: { terminal.promptText = $0 })
            },
            reply: { text in try await client.replySession(id: sessionID, text: text) })
        if let session = store.session(id: sessionID) { model.serverSessionChanged(session.status) }
        models[sessionID] = model
        return model
    }

    func resumeSucceeded(sessionID: String) { models[sessionID]?.resumeSucceeded() }

    private func prune(keeping ids: Set<String>) {
        for id in models.keys.filter({ !ids.contains($0) }) {
            models[id]?.teardown()
            models.removeValue(forKey: id)
        }
    }

    func teardown() {
        pruneWatcher?.cancel()
        pruneWatcher = nil
        for model in models.values { model.teardown() }
        whisperStatus.teardown()
        models = [:]
    }
}
