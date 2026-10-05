import SwiftUI
import ShepherdAppCore

/// Each activation gets its own presence/recovery lifetime, even while another server is focused.
struct IOSServerRuntimeView: View {
    let app: AppModel
    @Environment(IOSServerHub.self) private var hub
    @Environment(\.scenePhase) private var phase
    @State private var runtime: IOSServerRecovery?
    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .task {
                runtime = IOSServerRecovery(app: app)
                bindStore()
                await runtime?.update(mappedPhase)
            }
            .onChange(of: app.store.map(ObjectIdentifier.init)) { _, _ in bindStore() }
            .onChange(of: phase) { _, _ in Task { await runtime?.update(mappedPhase) } }
            .onChange(of: app.selectedSessionID) { _, selected in runtime?.selectionChanged(selected) }
            .onChange(of: app.store?.hasLoadedSessions) { _, _ in IOSPushRegistration.shared.routePendingNotification() }
            .onChange(of: app.store?.connection) { _, _ in IOSPushRegistration.shared.storeChanged() }
            .onChange(of: app.extension(QueuesModel.self)?.finishedSessions.map(\.id)) { _, _ in IOSPushRegistration.shared.routePendingNotification() }
            .onChange(of: app.store?.sessions.map(\.id)) { _, _ in IOSPushRegistration.shared.routePendingNotification() }
            .onDisappear { runtime?.teardown(); runtime = nil }
    }
    private var mappedPhase: IOSScenePhase {
        switch phase { case .active: .active; case .background: .background; default: .inactive }
    }
    private func bindStore() {
        app.extension(SidebarModel.self)?.lens = hub.lens
        runtime?.bindStore()
        IOSPushRegistration.shared.storeChanged()
    }
}

/// Watchers capture this coordinator weakly, rather than retaining SwiftUI State storage.
@MainActor
final class IOSServerRecovery {
    private weak var app: AppModel?
    private var lifecycle: IOSAppLifecycle?
    private var recovery: IOSVisibleActivityRecovery?
    init(app: AppModel) {
        self.app = app
        lifecycle = IOSAppLifecycle(app: app) { [weak self, weak app] in
            guard let app else { return }
            let generation = app.activationGeneration
            await app.extension(ReadOnlySidebarRecovery.self)?.refresh()
            guard generation == app.activationGeneration else { return }
            await self?.recovery?.reloadVisibleActivityIfNeeded()
        }
    }
    func update(_ phase: IOSScenePhase) async { await lifecycle?.update(phase) }
    func bindStore() {
        recovery?.storeDidChange(to: nil)
        if let app, let detail = app.extension(DetailModel.self) {
            detail.retainSession(app.selectedSessionID)
            recovery = IOSVisibleActivityRecovery(app: app, detail: detail, selectedID: { [weak app] in app?.selectedSessionID })
            recovery?.storeDidChange(to: app.store)
        } else { recovery = nil }
        lifecycle?.storeDidChange(app?.store)
    }
    func selectionChanged(_ selected: String?) {
        recovery?.cancelVisibleWork()
        app?.extension(DetailModel.self)?.retainSession(selected)
    }
    func teardown() {
        lifecycle?.storeDidChange(nil)
        recovery?.storeDidChange(to: nil)
        lifecycle = nil; recovery = nil
    }
}

/// The existing list remains the single-server fallback for previews and older fixtures.
struct IOSHubSessionListView: View {
    let select: (IOSSessionIdentity) -> Void
    @Environment(IOSServerHub.self) private var hub
    var body: some View {
        if let sidebar = hub.connected.compactMap({ $0.extension(SidebarModel.self) }).first {
            SessionListView(model: sidebar, select: { id in
                if let profile = hub.focused.activeProfile { select(.init(profileID: profile.id, sessionID: id)) }
            })
        }
    }
}
