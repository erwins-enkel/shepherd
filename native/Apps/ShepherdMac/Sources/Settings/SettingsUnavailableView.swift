import ShepherdAppCore
import AppKit
import SwiftUI
import ShepherdKit

/// The backend state needed by Settings is deliberately pure, so a disconnected
/// settings window can explain itself without creating a store or making a request.
enum SettingsBackendAvailability: Equatable, Sendable {
    case noProfile
    case remoteInactive
    case localOffline
    case localActive

    static func resolve(profile: ServerProfile?, localState: LocalServerState,
                        endpoint: URL = URL(string: "http://127.0.0.1:7330")!) -> Self {
        guard let profile else { return .noProfile }
        guard profile.mode == .local else { return .remoteInactive }
        guard profile.baseURL == endpoint else { return .remoteInactive }
        return localState.isRunning || localState == .externallyManaged ? .localActive : .localOffline
    }
}

struct SettingsUnavailableView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openWindow) private var openWindow
    let availability: SettingsBackendAvailability

    private var local: LocalServerModel { .shared }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
                .accessibilityIdentifier("settings-unavailable-title")
            Text(summary).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("settings-unavailable-summary")
            if availability == .localOffline || availability == .localActive {
                LocalServerPanel(model: local, app: app, onConnect: {
                    SettingsConnectionRouting.connectLocal(local, app: app, presentMain: showMainWindow)
                })
            } else if availability == .remoteInactive {
                Button(L.t("native_settings_connect")) { connectRemote() }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("settings-unavailable-action")
            } else if availability == .noProfile {
                Button(L.t("native_settings_choose_profile")) { showMainWindow() }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("settings-unavailable-action")
            }
        }
        .padding(24)
        .frame(maxWidth: 560, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    private var title: String {
        switch availability {
        case .noProfile: L.t("native_settings_no_profile_title")
        case .remoteInactive: L.t("native_settings_remote_inactive_title")
        case .localOffline: L.t("native_settings_local_offline_title")
        case .localActive: L.t("native_settings_local_active_title")
        }
    }

    private var summary: String {
        switch availability {
        case .noProfile: L.t("native_settings_no_profile_summary")
        case .remoteInactive: L.t("native_settings_remote_inactive_summary")
        case .localOffline: L.t("native_settings_local_offline_summary")
        case .localActive: L.t("native_settings_local_active_summary")
        }
    }

    private func showMainWindow() {
        SettingsConnectionRouting.showMainWindow { openWindow(id: "main") }
    }

    private func connectRemote() {
        guard let profile = app.activeProfile else { return }
        app.sheet = .login(profile)
        showMainWindow()
    }
}

/// Settings does not host login sheets: every connection route presents the main scene.
@MainActor
enum SettingsConnectionRouting {
    static func connectLocal(_ local: LocalServerModel, app: AppModel, presentMain: () -> Void) {
        local.connect(app)
        presentMain()
    }

    static func showMainWindow(windows: [NSWindow] = NSApp.windows, open: () -> Void) {
        if let window = windows.first(where: { $0.title == "Shepherd" }) {
            window.makeKeyAndOrderFront(nil)
        } else {
            open()
        }
    }
}
