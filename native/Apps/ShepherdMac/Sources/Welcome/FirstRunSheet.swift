import AppKit
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
    @State private var busy = false
    @State private var error: String?

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
            }

            if let error {
                Text(verbatim: error).font(.caption).foregroundStyle(.red)
            }

            HStack {
                Spacer()
                Button(busy ? L.t("common_loading") : L.t("native_firstrun_confirm")) { submit() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || chosen == nil)
            }
        }
        .padding(24)
        .frame(width: 520)
    }

    private func submit() {
        guard let chosen, let store = model.store, !busy else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                // resolveFirstRun PUTs the root and then refreshes the store, so
                // there is nothing to reload here.
                try await store.resolveFirstRun(path: chosen.path(percentEncoded: false))
                model.sheet = nil
                Log.app.info("first run resolved")
            } catch {
                self.error = L.t("native_firstrun_failed", ShepherdErrorCopy.message(error))
            }
        }
    }
}
