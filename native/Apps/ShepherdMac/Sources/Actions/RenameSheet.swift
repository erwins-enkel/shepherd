import ShepherdKit
import SwiftUI

/// Pure rules for the rename sheet, pulled out of the view so they are testable without
/// hosting SwiftUI (pattern: `LoginSheetState`, `NewSessionSubmission`).
enum RenameSubmission {
    /// The server rejects a name that is blank after trimming (`parseRenameName`), so the sheet
    /// refuses to send one rather than round-tripping a 400. A name that trims back to the one
    /// the session already has is a no-op, not a request: the web's `commitRename`
    /// (`ui/src/lib/components/Viewport.svelte:1029`) closes the dialog without calling the
    /// route, and so does this sheet.
    ///
    /// - Parameter current: the session's present name, so "unchanged" can be recognised. Left
    ///   empty by callers that only care about blankness.
    static func validate(_ raw: String, current: String = "") -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed != current.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// What to tell the operator afterwards. A rename whose branch did NOT move is not a
    /// failure, but it is also not what was asked for — an open PR pinned the head branch — and
    /// saying so is the difference between a surprise and an explanation.
    ///
    /// The server answers `branchRenamed: false` for two very different reasons
    /// (`src/server.ts:3359-3362`): a branch that exists but could not be moved, and a session
    /// that has no branch to move at all (non-isolated, or branchless). Only the first is worth
    /// a sentence, so the note is gated on the session actually having a branch — exactly the
    /// web's `if (session.branch && !res.branchRenamed)` at `Viewport.svelte:1036`.
    static func note(for result: RenameResult) -> String {
        if !result.branchRenamed, result.session.branch != nil {
            return L.t("viewport_rename_branch_kept")
        }
        return L.t("toast_renamed", result.session.name)
    }

    /// The 409 `name_taken` conflict comes back as the server's own word (`src/server.ts:3380`
    /// answers `{ error: "name_taken" }` with no separate `code`, so `ShepherdErrorCopy` hands
    /// the raw string through). Give it the sentence the web shows rather than echoing
    /// "name_taken" at the operator; everything else gets the generic rename failure.
    static func failureCopy(_ raw: String) -> String {
        raw == "name_taken" ? L.t("viewport_rename_name_taken") : L.t("viewport_rename_failed")
    }
}

struct RenameSheet: View {
    let session: Session
    let store: SessionStore
    let app: AppModel
    /// Called with the success note once the rename lands; the caller dismisses.
    let onDone: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String = ""
    @State private var command = SessionCommandState()
    @FocusState private var nameFocused: Bool

    /// Whether a completion may still touch this sheet's caller. The bar's own guard, called
    /// rather than re-declared, so the two can never drift: the store identity catches a profile
    /// switch, the selection catches the operator's selection moving off this session while the
    /// rename is in flight (a remote archive/reconcile can move it even while the sheet is up).
    private var isCurrent: Bool {
        ActionBarView.isCurrent(session: session, store: store, app: app)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(verbatim: L.t("viewport_rename_aria")).font(.headline)
            if let message = command.message {
                NoticeBar(message: message) { command.clear() }
            }
            TextField(L.t("viewport_rename_placeholder"), text: $name)
                .textFieldStyle(.roundedBorder)
                .focused($nameFocused)
                .onSubmit(submit)
                .accessibilityIdentifier("rename-field")
            HStack {
                Spacer()
                Button(L.t("common_cancel")) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(command.busy)
                Button(L.t("common_save"), action: submit)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!RenameSubmission.validate(name, current: session.name) || command.busy)
                    .accessibilityIdentifier("rename-submit")
            }
        }
        .padding(20)
        .frame(width: 420)
        .onAppear {
            name = session.name
            nameFocused = true
        }
        // Mirrors the Cancel button's .disabled(command.busy): the sheet's own close affordance
        // (Esc, click-outside) must not out-run the in-flight rename either — a completion
        // arriving after an interactive dismiss would otherwise write a note for a sheet that is
        // already gone.
        .interactiveDismissDisabled(command.busy)
    }

    private func submit() {
        // An unchanged name is a no-op, not a request: close without touching the server, the
        // same thing the web's `commitRename` does.
        guard RenameSubmission.validate(name, current: session.name) else {
            if !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !command.busy {
                dismiss()
            }
            return
        }
        let typed = name
        Task {
            var result: RenameResult?
            let ok = await command.run(
                { result = try await store.client.rename(sessionID: session.id, name: typed) },
                failureCopy: RenameSubmission.failureCopy,
                isCurrent: { isCurrent })
            guard ok, let result else { return }
            onDone(RenameSubmission.note(for: result))
        }
    }
}
