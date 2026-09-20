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

/// What a notice is telling the operator. Only the chrome differs — the bar's
/// layout, dismissal and accessibility identifier are the same either way.
///
/// The default everywhere is `.warning`, because that is what every notice in
/// the app was before the action bar arrived: a command failure, or a sign-out
/// whose token revoke did not go through. `.success` exists so the action bar's
/// one-line confirmations ("Stopped TASK-07", "Renamed…") stop reading as
/// something having gone wrong.
///
/// A plain enum with two computed properties rather than a `ViewModifier`, so
/// the mapping is assertable without hosting SwiftUI — `NoticeToneTests`.
enum NoticeTone: Equatable, Sendable {
    case warning
    case success

    var systemImage: String {
        switch self {
        case .warning: "exclamationmark.triangle.fill"
        case .success: "checkmark.circle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .warning: .orange
        case .success: .green
        }
    }
}

/// A dismissible one-line notice above a surface. Used for command failures
/// here and for a failed sign-out revoke in `RootView`, and — with
/// `tone: .success` — for the action bar's own confirmations.
///
/// `tone` defaults to `.warning`, so every call site that predates it keeps the
/// chrome it had.
struct NoticeBar: View {
    let message: String
    var tone: NoticeTone = .warning
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: tone.systemImage)
                .foregroundStyle(tone.tint)
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
        .background(tone.tint.opacity(0.12))
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
        Group {
            if let content = SidebarSlot.content {
                content(model)
            } else {
                builtInSessionList
                    .accessibilityIdentifier("session-sidebar")
            }
        }
        .navigationTitle(L.t("native_sidebar_title"))
    }

    /// The flat list Gate 2 shipped. S3 replaces it through `SidebarSlot`; it
    /// stays as the fallback so the app works on a branch without that stream.
    private var builtInSessionList: some View {
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
    }

    /// The connection-level banner, or `nil` when there is nothing to say.
    /// Both `store.connection` and `store.lastError` are `@Observable`-tracked,
    /// so SwiftUI re-evaluates this on its own whenever either moves.
    private var bannerKind: BannerKind? {
        guard let store = model.store, let profile = model.activeProfile else { return nil }
        return BannerPolicy.kind(
            for: store.connection,
            lastError: store.lastError,
            serverName: profile.name,
            serverVersion: model.serverVersion,
            appVersion: model.appVersion,
            minClient: model.serverMinClient,
            serverUnhealthy: model.serverUnhealthy)
    }

    private var detail: some View {
        VStack(spacing: 0) {
            // Above the command notice: the banner is about the connection the
            // whole window depends on, the notice about one command that failed.
            if let kind = bannerKind {
                // The retry task belongs to the model, not to this view: a
                // profile switch or a teardown has to be able to cancel it.
                ConnectionBanner(kind: kind, isRetrying: model.retrying) { model.retry() }
            }
            if let message = command.message {
                NoticeBar(message: message) { command.clear() }
            }
            SessionDetailView(session: selectedSession)
            // Only for a selected session against a live store — a quick action
            // has nothing to act on otherwise.
            if let session = selectedSession,
               let store = model.store,
               let actions = ActionBarSlot.content {
                actions(session, store, model)
            }
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
                // is added. Only signing out revokes: adding a server parks the
                // current profile with its token intact, because the welcome
                // screen lists saved servers and one click brings it back.
                Button(L.t("native_toolbar_add_server")) { model.deactivate() }
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
