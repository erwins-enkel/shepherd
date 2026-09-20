import ShepherdKit
import SwiftUI

/// Pure rules for the amend sheet.
enum AmendSubmission {
    /// `AMENDMENT_MAX_CHARS` in `src/task-amendments.ts`. Enforced here so the counter and the
    /// server agree; the server still re-checks.
    ///
    /// The unit is **UTF-16 code units**, not Swift's grapheme clusters, because that is what
    /// both halves of the existing product count: `src/server.ts` checks `text.length` on the
    /// trimmed text and the web's `AmendTaskDialog.svelte` counts `trimmed.length`, and JS
    /// `.length` is UTF-16. Counting graphemes would wave ~1 500 emoji (3 000 code units) past
    /// this gate with the counter still showing headroom, and the operator would get nothing
    /// back but the generic `amend_failed` line from the server's 400.
    static let maxCharacters = 2_000

    /// The trimmed length in UTF-16 code units — see `maxCharacters`.
    static func length(of raw: String) -> Int {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count
    }

    static func validate(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.utf16.count <= maxCharacters
    }

    /// The amendment is persisted before it is steered, so a delivery that did not land is still
    /// a recorded amendment — and must not read as a failure.
    static func note(steered: Bool) -> String {
        steered ? L.t("amend_recorded_and_steered") : L.t("amend_recorded_not_steered")
    }
}

struct AmendSheet: View {
    let session: Session
    let store: SessionStore
    let app: AppModel
    let onDone: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var steer = true
    @State private var command = SessionCommandState()
    @FocusState private var textFocused: Bool

    /// Counted the way the gate counts — UTF-16 code units, see `AmendSubmission.maxCharacters`
    /// — so the number on screen can never promise headroom `validate(_:)` would refuse.
    private var remaining: Int {
        AmendSubmission.maxCharacters - AmendSubmission.length(of: text)
    }

    /// See `RenameSheet.isCurrent`: the bar's own guard, called rather than re-declared. Store
    /// identity catches a profile switch, the selection catches the operator's selection moving
    /// off this session while the amendment is in flight.
    private var isCurrent: Bool {
        ActionBarView.isCurrent(session: session, store: store, app: app)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(verbatim: L.t("amend_title", session.name)).font(.headline)
            if let message = command.message {
                NoticeBar(message: message) { command.clear() }
            }
            GroupBox(L.t("amend_original_task")) {
                ScrollView {
                    Text(verbatim: session.prompt)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 120)
            }
            TextEditor(text: $text)
                .font(.body)
                .frame(minHeight: 120)
                .focused($textFocused)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text(verbatim: L.t("amend_placeholder"))
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 8)
                            .allowsHitTesting(false)
                    }
                }
                .accessibilityIdentifier("amend-field")
            HStack {
                Toggle(isOn: $steer) {
                    Text(verbatim: L.t("amend_steer_label"))
                }
                Spacer()
                Text(verbatim: "\(remaining)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(remaining < 0 ? .red : .secondary)
            }
            HStack {
                Spacer()
                Button(L.t("common_cancel")) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(command.busy)
                Button(command.busy ? L.t("amend_sending") : L.t("amend_submit"), action: submit)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!AmendSubmission.validate(text) || command.busy)
                    .accessibilityIdentifier("amend-submit")
            }
        }
        .padding(20)
        .frame(width: 520)
        .onAppear { textFocused = true }
        // Mirrors the Cancel button's .disabled(command.busy): the sheet's own close affordance
        // (Esc, click-outside) must not out-run the in-flight amendment either — see
        // RenameSheet's identical guard.
        .interactiveDismissDisabled(command.busy)
    }

    private func submit() {
        guard AmendSubmission.validate(text) else { return }
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let alsoSteer = steer
        Task {
            var created: AmendmentCreated?
            let ok = await command.run(
                {
                    created = try await store.client.amend(
                        sessionID: session.id, text: typed, steer: alsoSteer)
                },
                failureCopy: { _ in L.t("amend_failed") },
                isCurrent: { isCurrent })
            guard ok, let created else { return }
            // Not steering at all is a clean "recorded"; asking to steer and missing is the
            // case the operator has to hear about.
            onDone(alsoSteer ? AmendSubmission.note(steered: created.steered) : L.t("amend_recorded"))
        }
    }
}
