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

/// The sheet's busy/dismiss gate and resolve seam, pulled out of the view so
/// it is unit-testable without hosting SwiftUI (see FirstRunSubmissionTests,
/// pattern: `LoginSheetState`). Unlike the login sheet, there is no Cancel
/// button here — first run is mandatory — so this also owns the resolve call
/// itself: the one place that enforces "one resolve in flight" and "a stale
/// completion touches nothing".
///
/// A class, not a struct: the view needs `busy` to flip visibly for the
/// duration of the `await` below, and a struct's `self` inside an async
/// mutating method only writes back to `@State` once the whole method
/// returns, which would hide the in-flight state from SwiftUI entirely.
@Observable
@MainActor
final class FirstRunSubmission {
    private(set) var busy = false
    private(set) var message: String?
    /// Mirrors `LoginSheetState.canDismiss`: interactive dismissal must stay
    /// blocked while a resolve is in flight, same reasoning as there — there
    /// is no way to cancel the untracked `Task` `submit()` runs in.
    var canDismiss: Bool { !busy }

    /// Runs `resolve(path)`, unless a resolve is already in flight (a second
    /// call while `busy` is a no-op). `isCurrent` reports whether the sheet
    /// this submission started for is still the current one — false means
    /// the operator activated a different profile mid-flight, so neither
    /// `message` nor the "clear the sheet" signal applies and the completion
    /// is dropped silently (logged at debug).
    /// - Returns: whether the caller should now clear the sheet.
    @discardableResult
    func submit(
        path: String,
        using resolve: (String) async throws -> Void,
        isCurrent: () -> Bool
    ) async -> Bool {
        guard !busy else { return false }
        busy = true
        message = nil
        defer { busy = false }
        do {
            // resolveFirstRun PUTs the root and then refreshes the store, so
            // there is nothing to reload here.
            try await resolve(path)
            return isCurrent()
        } catch {
            if isCurrent() {
                message = L.t("native_firstrun_failed", ShepherdErrorCopy.message(error))
            } else {
                Log.app.debug("dropping a stale first-run completion")
            }
            return false
        }
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
