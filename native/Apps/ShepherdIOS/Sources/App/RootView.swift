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
            if composeFixtureEnabled {
                #if DEBUG
                IOSComposeFixtureView(app: app)
                #endif
            } else if app.activeProfile != nil, let sidebar = app.extension(SidebarModel.self) {
                ConnectionStatusView()
                if sizeClass == .regular {
                    NavigationSplitView {
                        SessionListView(model: sidebar, select: selectSession)
                    } detail: {
                        NavigationStack { selectedDetail }
                    }.accessibilityIdentifier("navigation-regular")
                } else {
                    NavigationStack(path: $path) {
                        SessionListView(model: sidebar, select: selectSession)
                            .navigationDestination(for: String.self) { _ in selectedDetail }
                    }.accessibilityIdentifier("navigation-compact")
                }
            } else {
                NavigationStack { ServerListView() }
            }
            if launch.configuration.isIsolated, launch.cleanup != nil {
                Button(L.t("native_toolbar_sign_out")) {
                    Task {
                        app.deactivate()
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
            case .newSession: IOSComposeSheet().environment(app)
            }
        }
        .task {
            if lifecycle == nil {
                lifecycle = IOSAppLifecycle(app: app) {
                    let generation = app.activationGeneration
                    await app.extension(ReadOnlySidebarRecovery.self)?.refresh()
                    guard generation == app.activationGeneration else { return }
                    await recovery?.reloadVisibleActivityIfNeeded()
                }
            }
            bindStore()
            await lifecycle?.update(mappedPhase)
        }
        .onChange(of: app.store.map(ObjectIdentifier.init)) { _, _ in bindStore() }
        .onChange(of: scenePhase) { _, phase in
            let mapped = Self.map(phase)
            Task { await lifecycle?.update(mapped) }
        }
        .onChange(of: app.selectedSessionID) { _, selected in
            recovery?.cancelVisibleWork()
            app.extension(DetailModel.self)?.retainSession(selected)
            path = selected.map { [$0] } ?? []
        }
        .onChange(of: path) { _, path in
            if sizeClass != .regular, path.isEmpty { app.selectedSessionID = nil }
        }
        .onChange(of: sizeClass) { _, _ in path = app.selectedSessionID.map { [$0] } ?? [] }
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
                .toolbar(.visible, for: .navigationBar)
        } else {
            ContentUnavailableView(L.t("native_detail_no_selection"), systemImage: "list.bullet")
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
    private func selectSession(_ id: String) {
        app.extension(DetailModel.self)?.retainSession(id)
        app.selectedSessionID = id
        path = [id]
    }
    private func bindStore() {
        recovery?.storeDidChange(to: nil)
        if let detail = app.extension(DetailModel.self) {
            detail.retainSession(app.selectedSessionID)
            recovery = IOSVisibleActivityRecovery(app: app, detail: detail, selectedID: { app.selectedSessionID })
            recovery?.storeDidChange(to: app.store)
        } else { recovery = nil }
        lifecycle?.storeDidChange(app.store)
    }
}
