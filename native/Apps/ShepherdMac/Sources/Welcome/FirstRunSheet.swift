import ShepherdAppCore
import AppKit
import Observation
import SwiftUI

/// NSOpenPanel is the one AppKit reach-through the design spec allows.
protocol FolderPicking: Sendable {
    @MainActor func chooseFolder(prompt: String) -> URL?
}

struct SystemFolderPicker: FolderPicking {
    @MainActor
    func chooseFolder(prompt: String) -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = prompt
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
        return panel.runModal() == .OK ? panel.url : nil
    }
}

/// Shown when the server reports firstRunPending: pick the workspace root and
/// PUT it, which also resolves first run server-side.
struct FirstRunSheet: View {
    var picker: any FolderPicking = SystemFolderPicker()

    @Environment(AppModel.self) private var model
    @State private var chosen: URL?
    @State private var submission = FirstRunSubmission()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(verbatim: L.t("native_firstrun_title")).font(.title2.weight(.semibold))
            Text(verbatim: L.t("native_firstrun_body"))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Text(verbatim: chosen?.path(percentEncoded: false) ?? "—")
                    .font(.system(.body, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.head)
                    .foregroundStyle(chosen == nil ? .secondary : .primary)
                Spacer()
                Button(L.t("native_firstrun_choose")) {
                    chosen = picker.chooseFolder(prompt: L.t("native_firstrun_confirm"))
                }
                .accessibilityIdentifier("firstrun-choose")
                .disabled(submission.busy)
            }

            if let message = submission.message {
                Text(verbatim: message).font(.caption).foregroundStyle(.red)
            }

            HStack {
                Spacer()
                Button(
                    submission.busy ? L.t("common_loading") : L.t("native_firstrun_confirm")
                ) { submit() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(submission.busy || chosen == nil)
            }
        }
        .padding(24)
        .frame(width: 520)
        // No Cancel button by design — first run is mandatory — so the
        // sheet's own close affordance (Esc, click-outside) must not out-run
        // an in-flight resolve either. Mirrors LoginSheet's
        // `.interactiveDismissDisabled(!state.canDismiss)`.
        .interactiveDismissDisabled(!submission.canDismiss)
    }

    private func submit() {
        guard let chosen, let store = model.store else { return }
        let path = chosen.path(percentEncoded: false)
        Task {
            // Captured once, up front: the identity check below must compare
            // against the store this submission started for, not whichever
            // store happens to be active when the resolve finishes.
            let cleared = await submission.submit(
                path: path,
                using: { try await store.resolveFirstRun(path: $0) },
                isCurrent: { model.store === store && model.sheet == .firstRun })
            if cleared {
                model.sheet = nil
                Log.app.info("first run resolved")
            }
        }
    }
}
