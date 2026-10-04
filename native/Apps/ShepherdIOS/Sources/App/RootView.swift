import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct RootView: View {
    let launch: IOSLaunchEnvironment
    @Environment(IOSServerHub.self) private var hub
    private var app: AppModel { hub.focused }
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var path: [IOSSessionIdentity] = []
    @State private var cleanupState = "pending"

    var body: some View {
        VStack(spacing: 0) {
            if let error = app.isolatedLaunchError { Text(verbatim: error).foregroundStyle(.red) }
            if hub.hasSidebar, !hub.managingServers, let warning = hub.catalogue.signOutWarning {
                Text(verbatim: warning).foregroundStyle(.orange)
            }
            if !composeFixtureEnabled { ConnectionStatusView() }
            if composeFixtureEnabled {
                #if DEBUG
                IOSComposeFixtureView(app: app)
                #endif
            } else if hub.hasSidebar, !hub.managingServers {
                if sizeClass == .regular {
                    NavigationSplitView {
                        IOSHubSessionListView(select: selectSession)
                    } detail: {
                        NavigationStack { selectedDetail }
                    }.accessibilityIdentifier("navigation-regular")
                } else {
                    NavigationStack(path: $path) {
                        IOSHubSessionListView(select: selectSession)
                            .navigationDestination(for: IOSSessionIdentity.self) { _ in selectedDetail }
                    }.accessibilityIdentifier("navigation-compact")
                }
            } else {
                NavigationStack { ServerListView().environment(hub.catalogue) }
            }
            if launch.configuration.isIsolated, launch.cleanup != nil {
                Button(L.t("native_toolbar_sign_out")) {
                    Task {
                        if let id = app.activeProfile?.id { hub.disconnect(id) }
                        do { try await launch.cleanup?.revoke(); cleanupState = "revocation_returned" }
                        catch { cleanupState = "pending" }
                    }
                }.accessibilityIdentifier("live-cleanup")
                Text(verbatim: cleanupState).accessibilityIdentifier("live-cleanup-status")
            }
        }
        .sheet(item: Binding(get: { hub.routedSheet }, set: { if $0 == nil { hub.dismissSheet() } })) { route in
            let app = route.model
            switch route.sheet {
            case .login(let profile): LoginSheet(profile: profile).environment(app)
            case .firstRun:
                NavigationStack {
                    VStack(spacing: 20) {
                        Text(verbatim: L.t("native_ios_first_run"))
                        Button(L.t("common_retry")) { app.sheet = nil; app.retry() }
                        Button(L.t("common_cancel")) { app.sheet = nil }
                    }.padding()
                }
            case .newSession: IOSMultiServerComposeSheet(owner: app).environment(app)
            }
        }
        .confirmationDialog(L.t("native_ios_notification_server"), isPresented: Binding(
            get: { !IOSPushRegistration.shared.notificationChoices.isEmpty },
            set: { if !$0 { IOSPushRegistration.shared.cancelNotification() } })) {
            ForEach(IOSPushRegistration.shared.notificationChoices, id: \.self) { identity in
                Button(hub.profiles.first { $0.id == identity.profileID }?.name ?? "") {
                    IOSPushRegistration.shared.chooseNotification(identity)
                }
            }
            Button(L.t("common_cancel"), role: .cancel) { IOSPushRegistration.shared.cancelNotification() }
        }
        .onChange(of: hub.selection) { _, selected in
            path = selected.map { [$0] } ?? []
        }
        .onChange(of: path) { _, path in
            if sizeClass != .regular, path.isEmpty { app.selectedSessionID = nil }
        }
        .onChange(of: sizeClass) { _, _ in path = hub.selection.map { [$0] } ?? [] }
    }

    private var composeFixtureEnabled: Bool {
        #if DEBUG
        launch.configuration.isIsolated && IOSComposeFixture.enabled && !IOSComposeFixture.sessionListEnabled
        #else
        false
        #endif
    }
    @ViewBuilder private var selectedDetail: some View {
        if let id = app.selectedSessionID,
           let session = app.store?.session(id: id) ?? app.extension(QueuesModel.self)?.finishedSessions.first(where: { $0.id == id }),
           let detail = app.extension(DetailModel.self),
           let terminals = app.extension(IOSTerminalController.self) {
            SessionDetailView(session: session, model: detail,
                terminal: terminals.model(for: id), defaults: launch.defaults)
                .id(DetailTaskKey(session: id, model: detail))
                .toolbar(.hidden, for: .navigationBar)
        } else {
            ContentUnavailableView(L.t("native_detail_no_selection"), systemImage: "list.bullet")
        }
    }
    private func selectSession(_ identity: IOSSessionIdentity) {
        hub.select(identity)
        path = [identity]
    }
}
