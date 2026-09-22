import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct RootView: View {
    let launch: IOSLaunchEnvironment
    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var lifecycle: IOSAppLifecycle?
    @State private var recovery: IOSVisibleActivityRecovery?
    @State private var path: [String] = []
    @State private var cleanupState = "pending"

    var body: some View {
        @Bindable var app = app
        VStack(spacing: 0) {
            if let error = app.isolatedLaunchError { Text(verbatim: error).foregroundStyle(.red) }
            if app.activeProfile != nil, let sidebar = app.extension(SidebarModel.self) {
                ConnectionStatusView()
                if sizeClass == .regular {
                    NavigationSplitView {
                        SessionListView(model: sidebar) { app.selectedSessionID = $0 }
                            .toolbar { serverToolbar }
                    } detail: {
                        NavigationStack { selectedDetail }
                    }.accessibilityIdentifier("navigation-regular")
                } else {
                    NavigationStack(path: $path) {
                        SessionListView(model: sidebar) { app.selectedSessionID = $0; path = [$0] }
                            .toolbar { serverToolbar }
                            .navigationDestination(for: String.self) { _ in selectedDetail }
                    }.accessibilityIdentifier("navigation-compact")
                }
            } else {
                NavigationStack { ServerListView() }
            }
            if launch.configuration.isIsolated, launch.cleanup != nil {
                Button(L.t("native_toolbar_sign_out")) {
                    Task {
                        do { try await launch.cleanup?.revoke(); cleanupState = "revocation_returned" }
                        catch { cleanupState = "pending" }
                    }
                }.accessibilityIdentifier("live-cleanup")
                Text(verbatim: cleanupState).accessibilityIdentifier("live-cleanup-status")
            }
        }
        .sheet(item: $app.sheet) { sheet in
            switch sheet {
            case .login(let profile): LoginSheet(profile: profile).environment(app)
            case .firstRun:
                NavigationStack {
                    VStack(spacing: 20) {
                        Text(verbatim: L.t("native_ios_first_run"))
                        Button(L.t("common_retry")) { app.sheet = nil; app.retry() }
                        Button(L.t("common_cancel")) { app.sheet = nil }
                    }.padding()
                }
            case .newSession: EmptyView()
            }
        }
        .task {
            if lifecycle == nil {
                lifecycle = IOSAppLifecycle(app: app) { await recovery?.reloadVisibleActivityIfNeeded() }
            }
            bindStore()
            await lifecycle?.update(mappedPhase)
        }
        .onChange(of: app.store.map(ObjectIdentifier.init)) { _, _ in bindStore() }
        .onChange(of: scenePhase) { _, phase in
            let mapped = Self.map(phase)
            Task { await lifecycle?.update(mapped) }
        }
        .onChange(of: app.store?.connection) { _, state in Task { await lifecycle?.connectionDidChange(state) } }
        .onChange(of: app.selectedSessionID) { _, selected in
            recovery?.cancelVisibleWork()
            path = selected.map { [$0] } ?? []
        }
        .onChange(of: path) { _, path in
            if sizeClass != .regular, path.isEmpty { app.selectedSessionID = nil }
        }
        .onChange(of: sizeClass) { _, _ in path = app.selectedSessionID.map { [$0] } ?? [] }
    }

    @ViewBuilder private var selectedDetail: some View {
        if let id = app.selectedSessionID, let session = app.store?.session(id: id),
           let detail = app.extension(DetailModel.self) {
            SessionDetailView(session: session, model: detail)
        } else {
            ContentUnavailableView(L.t("native_detail_no_selection"), systemImage: "list.bullet")
        }
    }
    @ToolbarContentBuilder private var serverToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button(L.t("native_toolbar_servers")) { app.deactivate() }
                .accessibilityIdentifier("show-servers")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button(L.t("native_toolbar_sign_out")) { Task { await app.signOutActiveReporting() } }
                .accessibilityIdentifier("sign-out")
        }
    }
    private var mappedPhase: IOSScenePhase { Self.map(scenePhase) }
    private static func map(_ phase: ScenePhase) -> IOSScenePhase {
        switch phase {
        case .active: .active
        case .inactive: .inactive
        case .background: .background
        @unknown default: .inactive
        }
    }
    private func bindStore() {
        recovery?.storeDidChange(to: nil)
        if let detail = app.extension(DetailModel.self) {
            recovery = IOSVisibleActivityRecovery(app: app, detail: detail, selectedID: { app.selectedSessionID })
            recovery?.storeDidChange(to: app.store)
        } else { recovery = nil }
        lifecycle?.storeDidChange(app.store)
    }
}
