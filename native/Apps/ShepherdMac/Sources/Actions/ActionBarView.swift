import ShepherdKit
import SwiftUI

/// The web's recap verdict chip plus its headline — the "Handlungsbedarf" line.
///
/// The derivation is a static function over a value rather than a computed property on the
/// view, so the three interesting cases (no recap, a recap still generating, a verdict this
/// build has never heard of) are assertable without hosting SwiftUI.
enum RecapLine {
    struct Content: Equatable, Sendable {
        let verdict: String
        let headline: String
        let openItems: Int
    }

    /// `nil` when there is nothing worth a line: no recap at all, or one whose headline is still
    /// empty because it has not finished generating.
    static func content(for recap: Recap?) -> Content? {
        guard let recap, !recap.headline.isEmpty else { return nil }
        return Content(
            verdict: label(for: recap.verdict),
            headline: recap.headline,
            openItems: recap.openItems.count)
    }

    /// An open enum: a verdict this build does not know still renders, as its raw wire value,
    /// rather than vanishing.
    private static func label(for verdict: RecapVerdict?) -> String {
        guard let verdict else { return "" }
        switch verdict.known {
        case .ready: return L.t("recap_verdict_ready")
        case .parked: return L.t("recap_verdict_parked")
        case .needsAttention: return L.t("recap_verdict_needs_attention")
        case nil: return verdict.rawValue
        }
    }

    static func tint(for verdict: RecapVerdict?) -> Color {
        switch verdict?.known {
        case .ready: .green
        case .needsAttention: .orange
        case .parked: .secondary
        default: .secondary
        }
    }
}

/// The quick-action bar under the detail pane.
///
/// Every action goes through `SessionCommandState` — the same gate `MainWindow`'s toolbar uses
/// for archive and interrupt — so exactly one command runs at a time, a failure lands in a
/// `NoticeBar` in the operator's language, and a completion for a store the operator has left
/// touches nothing. The one destructive action is behind a `confirmationDialog`.
struct ActionBarView: View {
    let session: Session
    let store: SessionStore
    let model: ActionsModel
    /// Reads the live store identity for `SessionCommandState.isCurrent`.
    let app: AppModel

    enum Sheet: String, Identifiable {
        case rename
        case amend
        var id: String { rawValue }
    }

    /// What tapping a bar button does, decoupled from the `@State` writes that carry it out —
    /// so the mapping itself (in particular, that `.relaunch` only ever asks for confirmation
    /// and never runs anything) is a pure fact `intent(for:)` can pin without hosting a view.
    enum RunIntent: Equatable {
        case presentSheet(Sheet)
        case confirmRelaunch
        case execute
    }

    static func intent(for action: SessionAction) -> RunIntent {
        switch action {
        case .rename: .presentSheet(.rename)
        case .amend: .presentSheet(.amend)
        case .relaunch: .confirmRelaunch
        case .stop, .resume, .toggleReady, .regenerateRecap: .execute
        }
    }

    /// Whether a completion started for `session`/`store` may still touch the bar that started
    /// it. Store identity catches a profile switch; the selection catches the operator's
    /// selection moving off this session while the command was in flight — a remote
    /// archive/reconcile can move it even though the request itself came from here. Static so it
    /// is testable without hosting a view: `ActionBarView.isCurrent(session:store:app:)`.
    static func isCurrent(session: Session, store: SessionStore, app: AppModel) -> Bool {
        app.store === store && app.selectedSessionID == session.id
    }

    @State private var command = SessionCommandState()
    @State private var sheet: Sheet?
    @State private var confirmingRelaunch = false
    /// A one-line success note (renamed, relaunched, amendment recorded) that fades on the next
    /// command. Separate from `command.message`, which is only ever a failure.
    @State private var note: String?

    private var actions: [SessionAction] { model.actions(for: session) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let message = command.message {
                NoticeBar(message: message) { command.clear() }
                    .accessibilityIdentifier("action-bar-error")
            }
            if let note {
                NoticeBar(message: note) { self.note = nil }
                    .accessibilityIdentifier("action-bar-note")
            }
            if let recap = RecapLine.content(for: model.recap(for: session.id)) {
                recapLine(recap)
            }
            buttons
        }
        .accessibilityIdentifier("action-bar")
        .accessibilityLabel(L.t("native_actions_bar_label"))
        .confirmationDialog(
            L.t("native_actions_relaunch_confirm_title"),
            isPresented: $confirmingRelaunch,
            titleVisibility: .visible
        ) {
            Button(L.t("native_actions_relaunch_confirm_action"), role: .destructive) {
                relaunch()
            }
            Button(L.t("common_cancel"), role: .cancel) {}
        } message: {
            Text(verbatim: L.t("native_actions_relaunch_confirm_body"))
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .rename:
                RenameSheet(session: session, store: store, app: app) { renamed in
                    note = renamed
                    sheet = nil
                }
            case .amend:
                AmendSheet(session: session, store: store, app: app) { recorded in
                    note = recorded
                    sheet = nil
                }
            }
        }
        // A different session is a different set of commands; carrying a notice across would
        // attribute one session's failure to another. The destructive dialog and the two sheets
        // go with it too — none of the three has anything to do with a session the bar has
        // moved on from.
        .onChange(of: session.id) { _, _ in
            resetForSessionChange()
            consumePendingOutcomeNote()
        }
        // The bar's *first* appearance for a session, not a change from a previous one — the
        // hook a relaunch's own outcome needs. A successful, archiving relaunch moves the
        // selection through `nil` on its way to the replacement (`MainWindow`'s
        // `reconcileSelection` reacts to the archive event before this bar is told to select
        // the replacement), which tears this view down and stands up a fresh one rather than
        // updating one already on screen — `onChange` never fires for that transition, only
        // `onAppear` does.
        .onAppear { consumePendingOutcomeNote() }
    }

    private func resetForSessionChange() {
        command.clear()
        note = nil
        sheet = nil
        confirmingRelaunch = false
    }

    /// Takes this session's outcome note from the model, if one is waiting — see
    /// `ActionsModel.recordOutcomeNote(_:forSessionID:)`.
    private func consumePendingOutcomeNote() {
        if let pending = model.consumeOutcomeNote(forSessionID: session.id) {
            note = pending
        }
    }

    private func recapLine(_ content: RecapLine.Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: content.verdict)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(
                    RecapLine.tint(for: model.recap(for: session.id)?.verdict).opacity(0.18),
                    in: Capsule())
                .foregroundStyle(RecapLine.tint(for: model.recap(for: session.id)?.verdict))
            Text(verbatim: content.headline)
                .font(.callout)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            if content.openItems > 0 {
                Text(verbatim: "\(L.t("recap_open_items")): \(content.openItems)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .accessibilityIdentifier("action-bar-recap")
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            ForEach(actions) { action in
                Button {
                    run(action)
                } label: {
                    Label(action.label(for: session), systemImage: action.systemImage)
                }
                .help(action.help(for: session))
                .disabled(command.busy)
                .modifier(ShortcutModifier(shortcut: action.shortcut))
                .accessibilityIdentifier("action-\(action.id)")
            }
            Spacer(minLength: 0)
            if command.busy { ProgressView().controlSize(.small) }
        }
        .buttonStyle(.bordered)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: - Running a command

    private func run(_ action: SessionAction) {
        switch Self.intent(for: action) {
        case .presentSheet(let which): sheet = which
        case .confirmRelaunch: confirmingRelaunch = true
        case .execute:
            switch action {
            case .stop: interrupt()
            case .resume: resume()
            case .toggleReady: toggleReady()
            case .regenerateRecap: regenerateRecap()
            case .rename, .amend, .relaunch:
                assertionFailure("intent(for:) mapped \(action.id) to .execute")
            }
        }
    }

    /// `session`/`store`/`app` bound at this closure's construction — see the type's static
    /// `isCurrent(session:store:app:)` for what the two halves catch.
    private var isCurrent: Bool {
        Self.isCurrent(session: session, store: store, app: app)
    }

    private func interrupt() {
        let name = session.name
        Task {
            let ok = await command.run(
                { try await store.interrupt(id: session.id) },
                failureCopy: { _ in L.t("cardmenu_stop_failed", name) },
                isCurrent: { isCurrent })
            if ok { note = L.t("cardmenu_stop_toast", name) }
        }
    }

    private func resume() {
        let name = session.name
        Task {
            await command.run(
                { _ = try await store.client.resume(sessionID: session.id) },
                failureCopy: { _ in L.t("cardmenu_resume_failed", name) },
                isCurrent: { isCurrent })
        }
    }

    private func toggleReady() {
        let next = !session.readyToMerge
        Task {
            await command.run(
                { try await store.client.setReadyToMerge(sessionID: session.id, ready: next) },
                failureCopy: { L.t("native_actions_failed", $0) },
                isCurrent: { isCurrent })
        }
    }

    private func regenerateRecap() {
        Task {
            await command.run(
                { _ = try await store.client.regenerateRecap(sessionID: session.id) },
                failureCopy: { _ in L.t("recap_regenerate_failed") },
                isCurrent: { isCurrent })
        }
    }

    private func relaunch() {
        Task {
            var outcome: RelaunchResult?
            // Kept because `SessionCommandState.run` hands `failureCopy` only the already-mapped
            // string, and `ShepherdErrorCopy` never looks at a conflict's code — see
            // `ActionErrorCopy`. Both closures are non-escaping and run on this actor, in order,
            // so the assignment is visible by the time the copy is asked for.
            var thrown: (any Error)?
            let ok = await command.run(
                {
                    do {
                        outcome = try await store.client.relaunch(sessionID: session.id)
                    } catch {
                        thrown = error
                        throw error
                    }
                },
                failureCopy: { ActionErrorCopy.relaunchFailure(thrown, fallback: $0) },
                // Store identity only, deliberately weaker than `isCurrent`: an *archiving*
                // success removes `session.id` from the store's list before this closure runs
                // (the archive event reaches `MainWindow.reconcileSelection` while this call is
                // still in flight), so gating success on `app.selectedSessionID == session.id`
                // would make an archiving relaunch's own success unreachable. A profile switch
                // is still the right thing to drop a completion for.
                isCurrent: { app.store === store })
            guard ok, let outcome else { return }
            let text =
                outcome.archived
                ? L.t("relaunch_done", outcome.session.desig)
                : L.t("relaunch_archive_failed")
            if outcome.archived {
                // This bar is about to unmount — the archive event already moved, or is about
                // to move, the selection off `session.id`. The model outlives that; the
                // replacement is where the note belongs once it becomes the selection, the same
                // way `NewSessionSheet` selects the session it just created.
                model.recordOutcomeNote(text, forSessionID: outcome.session.id)
                app.selectedSessionID = outcome.session.id
            } else {
                // Nothing moved: the original is still on the list and still selected, so the
                // bar showing it right now is still the right place for the note.
                note = text
            }
        }
    }
}

/// `keyboardShortcut` has no optional form, so the choice is made once here instead of at seven
/// call sites.
private struct ShortcutModifier: ViewModifier {
    let shortcut: ActionShortcut?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let shortcut {
            content.keyboardShortcut(KeyEquivalent(shortcut.key), modifiers: shortcut.modifiers)
        } else {
            content
        }
    }
}
