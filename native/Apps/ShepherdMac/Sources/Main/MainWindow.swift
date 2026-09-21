import ShepherdAppCore
import Observation
import SwiftUI
import ShepherdKit

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
        .sheet(isPresented: $confirmingArchive) {
            if let session = selectedSession, let store = model.store {
                ComposeActionSheet(mode: .close, session: session, store: store, app: model,
                    activation: model.activationGeneration)
            }
        }
        // A session archived anywhere else arrives as an event that removes the
        // row; the selection has to follow it out, or the toolbar keeps offering
        // commands for a session that is gone.
        .onChange(of: sessions.map(\.id)) { _, ids in
            model.reconcileSelection(against: ids)
            if selectedSession == nil { confirmingArchive = false }
        }
        .onChange(of: model.selectedSessionID) { _, _ in confirmingArchive = false }
        // The notice names a command against the profile being left.
        .onChange(of: model.activeProfile?.id) { _, _ in command.clear(); confirmingArchive = false }
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
                    SessionRow(session: session)
                        .modifier(SettingsStatusShape(status: session.status)).tag(session.id)
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
                Self.openComposer(model)
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

    static func openComposer(_ model: AppModel) { model.sheet = .newSession }

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
