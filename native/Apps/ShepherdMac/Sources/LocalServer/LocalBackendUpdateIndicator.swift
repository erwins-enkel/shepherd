import Foundation
import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// Only the connected profile belonging to our supervised child gets a badge.
struct LocalBackendUpdateIndicatorState {
    static func count(profile: ServerProfile?, endpoint: URL, state: LocalServerState,
                      managesUpdates: Bool, behind: Int) -> Int? {
        guard managesUpdates, state.isRunning, behind > 0,
              let profile, profile.mode == .local,
              profile.baseURL.scheme == endpoint.scheme,
              profile.baseURL.port == endpoint.port,
              ["127.0.0.1", "localhost", "::1"].contains(profile.baseURL.host(percentEncoded: false) ?? ""),
              ["", "/"].contains(profile.baseURL.path),
              profile.baseURL.user == nil, profile.baseURL.password == nil else { return nil }
        return behind
    }
}

/// Mounted once below MainWindow, outside its DetailTab/TabView hierarchy.
struct LocalBackendUpdateIndicator: View {
    let model: LocalServerModel
    let app: AppModel
    @State private var showingPanel = false

    var body: some View {
        Group {
            if let count = LocalBackendUpdateIndicatorState.count(profile: app.activeProfile,
                endpoint: model.baseURL, state: model.state,
                managesUpdates: model.canManageUpdates, behind: model.updateStatus?.behind ?? 0) {
                HStack {
                    Button { showingPanel = true } label: {
                        Label(L.t("native_local_update_indicator", String(count)), systemImage: "arrow.down.circle")
                    }
                    .buttonStyle(.borderless)
                    .font(.callout)
                    .accessibilityIdentifier("local-backend-update-indicator")
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .background(.bar)
            }
        }
        .sheet(isPresented: $showingPanel) {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text(verbatim: L.t("native_settings_local_server_title")).font(.headline)
                    Spacer()
                    Button(L.t("common_close")) { showingPanel = false }
                }
                ScrollView { LocalServerPanel(model: model, app: app) }
            }
            .padding(24)
            .frame(width: 640, height: 540)
        }
        .onChange(of: app.activeProfile?.id) { _, _ in showingPanel = false }
    }
}
