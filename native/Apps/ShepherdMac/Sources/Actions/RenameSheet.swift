import ShepherdKit
import SwiftUI

/// Pure rules for the rename sheet, pulled out of the view so they are testable without
/// hosting SwiftUI (pattern: `LoginSheetState`, `NewSessionSubmission`).
enum RenameSubmission {
    /// The server rejects a name that is blank after trimming (`parseRenameName`), so the sheet
    /// refuses to send one rather than round-tripping a 400.
    static func validate(_ raw: String) -> Bool {
        !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// What to tell the operator afterwards. A rename whose branch did NOT move is not a
    /// failure, but it is also not what was asked for — an open PR pinned the head branch — and
    /// saying so is the difference between a surprise and an explanation.
    static func note(for result: RenameResult) -> String {
        result.branchRenamed
            ? L.t("toast_renamed", result.session.name)
            : L.t("viewport_rename_branch_kept")
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

    /// Whether a completion may still touch this sheet's caller. Two halves, for the same
    /// reason `ActionBarView.isCurrent` has them: the store identity catches a profile switch,
    /// the selection catches the operator's selection moving off this session while the rename
    /// is in flight (a remote archive/reconcile can move it even while the sheet is up).
    private var isCurrent: Bool {
        app.store === store && app.selectedSessionID == session.id
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
                    .disabled(!RenameSubmission.validate(name) || command.busy)
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
        guard RenameSubmission.validate(name) else { return }
        let typed = name
        Task {
            var result: RenameResult?
            let ok = await command.run(
                { result = try await store.client.rename(sessionID: session.id, name: typed) },
                // 409 name_taken comes back as the server's own word; give it the sentence the
                // web shows rather than echoing "name_taken" at the operator.
                failureCopy: { raw in
                    raw == "name_taken"
                        ? L.t("viewport_rename_name_taken") : L.t("viewport_rename_failed")
                },
                isCurrent: { isCurrent })
            guard ok, let result else { return }
            onDone(RenameSubmission.note(for: result))
        }
    }
}
