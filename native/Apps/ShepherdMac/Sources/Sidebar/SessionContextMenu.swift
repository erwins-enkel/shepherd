import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// What the right-click menu on a session card runs, and the sheets it opens.
///
/// A right-click does not select the card, but every action it reaches (`RenameSheet`,
/// `AmendSheet`, `ComposeActionSheet`, the relaunch guard) treats "the selected session" as the
/// one it acts on. So `perform` selects the card the menu was opened on first — the target is the
/// row's own session id, never whatever happened to be selected — and only then acts. The
/// menu's entries, and which of them exist, come from `ActionsModel.contextMenu(for:)`, so they
/// follow the same status rules as the action bar and the web's `CardMenu`.
@MainActor
@Observable
final class SessionContextController {
    enum Sheet: Identifiable, Equatable {
        case rename(String), amend(String), relaunch(String), compose(ComposeActions.Action, String), manualSteps(String)

        var id: String {
            switch self {
            case .rename(let id): "rename-\(id)"
            case .amend(let id): "amend-\(id)"
            case .relaunch(let id): "relaunch-\(id)"
            case .compose(let mode, let id): "\(mode.rawValue)-\(id)"
            case .manualSteps(let id): "manual-steps-\(id)"
            }
        }

        var sessionID: String {
            switch self {
            case .rename(let id), .amend(let id), .relaunch(let id), .compose(_, let id), .manualSteps(let id): id
            }
        }
    }

    var sheet: Sheet?
    var note: ActionNote?
    let command = SessionCommandState()

    /// The sheet each menu entry opens, or `nil` for the ones that run straight away. Pure, so
    /// "destructive actions still ask" is pinned by a test rather than read off the view.
    static func sheet(for action: SessionContextAction, sessionID id: String) -> Sheet? {
        switch action {
        case .rename: .rename(id)
        case .amend: .amend(id)
        case .relaunch, .relaunchElsewhere: .relaunch(id)
        case .variant: .compose(.variant, id)
        case .replace: .compose(.replace, id)
        case .decommission: .compose(.close, id)
        case .stop, .resume, .cleanTerminal: nil
        }
    }

    func perform(_ action: SessionContextAction, sessionID id: String, app: AppModel) {
        guard let store = app.store, let session = store.session(id: id) else { return }
        app.selectedSessionID = id
        note = nil
        command.clear()
        if let sheet = Self.sheet(for: action, sessionID: id) {
            self.sheet = sheet
            return
        }
        switch action {
        case .stop: stop(session, store: store, app: app)
        case .resume: resume(session, store: store, app: app)
        case .cleanTerminal: cleanTerminal(repoPath: session.repoPath, store: store, app: app)
        default: break
        }
    }

    private func stop(_ session: Session, store: SessionStore, app: AppModel) {
        let name = session.name
        Task {
            let ok = await command.run(
                { try await store.interrupt(id: session.id) },
                failureCopy: { _ in L.t("cardmenu_stop_failed", name) },
                isCurrent: { app.store === store })
            if ok { note = .success(L.t("cardmenu_stop_toast", name)) }
        }
    }

    private func resume(_ session: Session, store: SessionStore, app: AppModel) {
        let name = session.name
        Task {
            let ok = await command.run(
                { _ = try await store.client.resume(sessionID: session.id) },
                failureCopy: { _ in L.t("cardmenu_resume_failed", name) },
                isCurrent: { app.store === store })
            if ok { note = .success(L.t("native_actions_resumed", name)) }
        }
    }

    /// One bare shell per repo in its main checkout: focus the live one when there is one, else
    /// create it. A 409 means another client won the race — its row arrives over the socket, so
    /// a re-lookup usually resolves it (the web does the same).
    private func cleanTerminal(repoPath: String, store: SessionStore, app: AppModel) {
        func live() -> Session? { store.sessions.first { $0.terminal == true && $0.repoPath == repoPath } }
        if let existing = live() {
            app.selectedSessionID = existing.id
            return
        }
        var thrown: (any Error)?
        Task {
            let ok = await command.run(
                {
                    do {
                        let created = try await store.client.createTerminalSession(repoPath: repoPath)
                        store.apply(.sessionNew(created))
                    } catch {
                        thrown = error
                        throw error
                    }
                },
                failureCopy: { _ in
                    String(describing: thrown).contains("terminal_unsupported")
                        ? L.t("toast_terminal_unsupported") : L.t("toast_terminal_failed")
                },
                isCurrent: { app.store === store })
            if ok { app.selectedSessionID = live()?.id } else if let existing = live() {
                command.clear()
                app.selectedSessionID = existing.id
            }
        }
    }

    func relaunch(_ session: Session, overrides: RelaunchRequest, store: SessionStore, app: AppModel) {
        Task {
            var outcome: RelaunchResult?
            var thrown: (any Error)?
            let ok = await command.run(
                {
                    do {
                        outcome = try await store.client.relaunch(sessionID: session.id, overrides: overrides)
                    } catch {
                        thrown = error
                        throw error
                    }
                },
                failureCopy: { ActionErrorCopy.relaunchFailure(thrown, fallback: $0) },
                isCurrent: { ActionBarView.relaunchIsCurrent(session: session, store: store, app: app) })
            guard ok, let outcome else { return }
            let result = ActionBarView.relaunchOutcomeNote(outcome)
            if outcome.archived {
                app.extension(ActionsModel.self)?.recordOutcomeNote(result.text, forSessionID: outcome.session.id)
                app.selectedSessionID = outcome.session.id
            } else {
                note = result
            }
        }
    }
}

/// The menu itself. Built per card from that card's own session.
struct SessionContextMenuItems: View {
    @Environment(AppModel.self) private var app
    let session: Session
    let controller: SessionContextController

    var body: some View {
        if let model = app.extension(ActionsModel.self) {
            ForEach(model.contextMenu(for: session)) { action in
                if action == .decommission { Divider() }
                Button(role: action.isDestructive ? .destructive : nil) {
                    controller.perform(action, sessionID: session.id, app: app)
                } label: {
                    Label(action.label, systemImage: action.systemImage)
                }
                .accessibilityIdentifier("context-\(action.id)")
            }
        }
    }
}

/// Hosts what the menu opens: its notices and its sheets. One per sidebar, so a sheet outlives
/// the row that opened it (rows are recreated whenever the list re-sorts).
struct SessionContextHost: ViewModifier {
    @Environment(AppModel.self) private var app
    let controller: SessionContextController

    func body(content: Content) -> some View {
        @Bindable var controller = controller
        VStack(spacing: 0) {
            if let message = controller.command.message {
                NoticeBar(message: message) { controller.command.clear() }
                    .accessibilityIdentifier("context-menu-error")
            }
            if let note = controller.note {
                NoticeBar(message: note.text, tone: note.tone) { controller.note = nil }
                    .accessibilityIdentifier("context-menu-note")
            }
            content
        }
        .sheet(item: $controller.sheet) { sheet in sheetContent(sheet) }
        // A sheet for a session that left the store (archived elsewhere) has nothing to act on.
        .onChange(of: app.store?.sessions.map(\.id)) { _, ids in
            if let sheet = controller.sheet, !(ids ?? []).contains(sheet.sessionID) { controller.sheet = nil }
        }
    }

    @ViewBuilder
    private func sheetContent(_ sheet: SessionContextController.Sheet) -> some View {
        if let store = app.store, let session = store.session(id: sheet.sessionID) {
            switch sheet {
            case .rename:
                RenameSheet(session: session, store: store, app: app) { renamed in
                    controller.note = .success(renamed)
                    controller.sheet = nil
                }
            case .amend:
                AmendSheet(session: session, store: store, app: app) { recorded in
                    controller.note = .success(recorded)
                    controller.sheet = nil
                }
            case .relaunch:
                RelaunchOptionsView(session: session, repos: store.repos) { overrides in
                    controller.sheet = nil
                    controller.relaunch(session, overrides: overrides, store: store, app: app)
                }
            case .compose(let mode, _):
                ComposeActionSheet(mode: mode, session: session, store: store, app: app,
                    activation: app.activationGeneration)
            case .manualSteps:
                if let model = app.extension(MergeModel.self) {
                    VStack(alignment: .trailing, spacing: 0) {
                        Button(L.t("common_close")) { controller.sheet = nil }
                            .keyboardShortcut(.cancelAction)
                            .padding()
                        ScrollView {
                            MergeSessionView(app: app, session: session, store: store, model: model)
                        }
                    }
                    .frame(width: 560, height: 600)
                    .accessibilityIdentifier("session-manual-steps-\(session.id)")
                }
            }
        }
    }
}
