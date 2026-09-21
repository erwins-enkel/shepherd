import ShepherdAppCore
import ShepherdKit
import SwiftUI

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
