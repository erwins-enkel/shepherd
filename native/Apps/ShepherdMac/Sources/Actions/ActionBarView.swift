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
            }
            if let note {
                NoticeBar(message: note) { self.note = nil }
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
        // attribute one session's failure to another.
        .onChange(of: session.id) { _, _ in
            command.clear()
            note = nil
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
        switch action {
        case .rename: sheet = .rename
        case .amend: sheet = .amend
        case .relaunch: confirmingRelaunch = true
        case .stop: interrupt()
        case .resume: resume()
        case .toggleReady: toggleReady()
        case .regenerateRecap: regenerateRecap()
        }
    }

    /// Whether a completion may still touch this view.
    ///
    /// Two halves, because a command can be outlived by two different things. The store identity
    /// is `MainWindow`'s own test — the operator switched profiles, so the whole activation is
    /// gone. The selection is this bar's: `MainWindow` renders the slot only for
    /// `selectedSession`, so a bar whose session is no longer selected is about to be handed a
    /// different one, and its `note`/`command.message` are `@State` that would survive the swap
    /// and read as the new session's. `session` here is the value this view was built with; the
    /// comparison is against the live model, which is a reference.
    private var isCurrent: Bool {
        app.store === store && app.selectedSessionID == session.id
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
                isCurrent: { isCurrent })
            guard ok, let outcome else { return }
            // The replacement arrives as session:new; the original leaves as session:archived,
            // and `MainWindow.reconcileSelection` moves the selection off it. Saying so matters
            // when it did NOT: a relaunch that could not decommission the original leaves two
            // rows, and the operator has to know which one is live.
            note =
                outcome.archived
                ? L.t("relaunch_done", outcome.session.desig)
                : L.t("relaunch_archive_failed")
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
