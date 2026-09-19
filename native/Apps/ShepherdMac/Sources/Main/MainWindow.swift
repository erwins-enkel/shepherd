import Observation
import SwiftUI
import ShepherdKit

/// The toolbar's busy/error gate for the two session commands, pulled out of
/// the view so it is unit-testable without hosting SwiftUI (pattern:
/// `LoginSheetState`, `FirstRunSubmission`, `NewSessionSubmission`).
///
/// It exists because a command that only logs its failure is a command the
/// operator watches do nothing: archive against a server that refuses it left
/// the row in place with no explanation anywhere they could see.
@Observable
@MainActor
final class SessionCommandState {
    private(set) var busy = false
    private(set) var message: String?

    func clear() { message = nil }

    /// Runs `command` unless one is already in flight. `failureCopy` turns the
    /// already-mapped `ShepherdErrorCopy` line into the sentence for this
    /// particular command. `isCurrent` reports whether the store the command
    /// went to is still the active one — a completion for a store the operator
    /// has moved on from touches nothing and is logged at debug.
    /// - Returns: whether the command succeeded *and* is still current, which
    ///   is the only case where the caller may act on it.
    @discardableResult
    func run(
        _ command: () async throws -> Void,
        failureCopy: (String) -> String,
        isCurrent: () -> Bool
    ) async -> Bool {
        guard !busy else { return false }
        busy = true
        message = nil
        defer { busy = false }
        do {
            try await command()
            return isCurrent()
        } catch {
            if isCurrent() {
                message = failureCopy(ShepherdErrorCopy.message(error))
            } else {
                Log.ui.debug("dropping a stale session-command failure")
            }
            return false
        }
    }
}

/// A dismissible one-line notice above a surface. Used for command failures
/// here and for a failed sign-out revoke in `RootView`.
struct NoticeBar: View {
    let message: String
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .accessibilityHidden(true)
            Text(verbatim: message)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button(L.t("common_close"), systemImage: "xmark", action: onDismiss)
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.12))
        .accessibilityIdentifier("notice-bar")
    }
}

struct MainWindow: View {
    @Environment(AppModel.self) private var model
    @State private var confirmingArchive = false
    @State private var command = SessionCommandState()

    var body: some View {
        NavigationSplitView {
            sidebar.navigationSplitViewColumnWidth(min: 260, ideal: 300, max: 420)
        } detail: {
            detail
        }
        .navigationTitle(model.activeProfile?.name ?? "Shepherd")
        .toolbar { toolbarContent }
        .confirmationDialog(
            L.t("native_archive_confirm_title"),
            isPresented: $confirmingArchive,
            titleVisibility: .visible
        ) {
            Button(L.t("native_archive_confirm_action"), role: .destructive) { archiveSelected() }
            Button(L.t("common_cancel"), role: .cancel) {}
        } message: {
            Text(verbatim: L.t("native_archive_confirm_body"))
        }
        // A session archived anywhere else arrives as an event that removes the
        // row; the selection has to follow it out, or the toolbar keeps offering
        // commands for a session that is gone.
        .onChange(of: sessions.map(\.id)) { _, ids in model.reconcileSelection(against: ids) }
        // The notice names a command against the profile being left.
        .onChange(of: model.activeProfile?.id) { _, _ in command.clear() }
    }

    private var sessions: [Session] { model.store?.sessions ?? [] }

    private var selectedSession: Session? {
        guard let id = model.selectedSessionID else { return nil }
        return sessions.first { $0.id == id }
    }

    private var sidebar: some View {
        @Bindable var model = model

        return Group {
            if sessions.isEmpty {
                ContentUnavailableView(L.t("native_sidebar_empty"), systemImage: "tray")
            } else {
                List(sessions, id: \.id, selection: $model.selectedSessionID) { session in
                    SessionRow(session: session).tag(session.id)
                }
            }
        }
        .navigationTitle(L.t("native_sidebar_title"))
        .accessibilityIdentifier("session-sidebar")
    }

    private var detail: some View {
        VStack(spacing: 0) {
            if let message = command.message {
                NoticeBar(message: message) { command.clear() }
            }
            SessionDetailView(session: selectedSession)
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Menu {
                ForEach(model.profiles) { profile in
                    Button {
                        Task { await model.activate(profile) }
                    } label: {
                        Label(
                            profile.name,
                            systemImage: profile.id == model.activeProfile?.id
                                ? "checkmark" : "server.rack")
                    }
                }
                Divider()
                // Both drop back to the welcome screen — that is where a server
                // is added, and signing out clears the active profile. Adding a
                // server signs out too, rather than just ending the activation:
                // the welcome screen does not list stored profiles, so a parked
                // profile is reachable only from another profile's switcher, and
                // a token left valid under a row the operator cannot get back to
                // is exactly the un-revokable credential `remove(_:)` exists to
                // prevent.
                Button(L.t("native_toolbar_add_server")) { signOut() }
                Button(L.t("native_toolbar_sign_out")) { signOut() }
            } label: {
                Label(L.t("native_toolbar_servers"), systemImage: "server.rack")
            }
            .accessibilityIdentifier("toolbar-servers")
        }

        ToolbarItemGroup {
            Button {
                model.sheet = .newSession
            } label: {
                Label(L.t("native_toolbar_new_session"), systemImage: "plus")
            }
            .help(L.t("native_toolbar_new_session"))
            .accessibilityIdentifier("toolbar-new-session")

            Button {
                interruptSelected()
            } label: {
                Label(L.t("native_toolbar_interrupt"), systemImage: "stop.circle")
            }
            .help(L.t("native_toolbar_interrupt"))
            .disabled(selectedSession == nil || command.busy)
            .accessibilityIdentifier("toolbar-interrupt")

            Button {
                confirmingArchive = true
            } label: {
                Label(L.t("native_toolbar_archive"), systemImage: "archivebox")
            }
            .help(L.t("native_toolbar_archive"))
            .disabled(selectedSession == nil || command.busy)
            .accessibilityIdentifier("toolbar-archive")
        }
    }

    private func archiveSelected() {
        guard let store = model.store, let id = model.selectedSessionID else { return }
        Task {
            let archived = await command.run(
                { try await store.archive(id: id) },
                failureCopy: { L.t("native_archive_failed", $0) },
                isCurrent: { model.store === store })
            // Only clear the selection once the row is actually gone; a failed
            // archive must leave the operator where they were.
            if archived, model.selectedSessionID == id { model.selectedSessionID = nil }
        }
    }

    private func interruptSelected() {
        guard let store = model.store, let id = model.selectedSessionID else { return }
        Task {
            await command.run(
                { try await store.interrupt(id: id) },
                failureCopy: { L.t("native_interrupt_failed", $0) },
                isCurrent: { model.store === store })
        }
    }

    /// The revoke may fail while the local sign-out still goes through, and the
    /// operator has to hear about it — a token they believe is dead but the
    /// server still honours is worse than no sign-out at all. Both the notice
    /// and the copy for it live on the model rather than in this view, because
    /// this view is gone by the time the call returns.
    private func signOut() {
        Task { await model.signOutActiveReporting() }
    }
}
