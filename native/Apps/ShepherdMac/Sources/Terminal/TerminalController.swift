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
    private var models: [String: TerminalSessionModel] = [:]

    required init(store: SessionStore, app: AppModel) {
        self.store = store
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

    func teardown() {
        for model in models.values { model.detach() }
        models = [:]
    }
}
