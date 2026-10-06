import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct ConnectionStatusView: View {
    @Environment(IOSServerHub.self) private var hub: IOSServerHub?
    var body: some View {
        if let hub {
            ForEach(hub.connectedIDs, id: \.self) { id in
                if let model = hub.models[id] {
                    IOSServerConnectionStatus(showSpinner: !hub.hasLoadedList,
                        serverName: hub.connected.count > 1 ? model.activeProfile?.name : nil).environment(model)
                }
            }
        } else { IOSServerConnectionStatus() }
    }
    static func isFirstRun(_ state: ConnectionState) -> Bool { IOSServerConnectionStatus.isFirstRun(state) }
    static func isConnecting(_ state: ConnectionState) -> Bool { IOSServerConnectionStatus.isConnecting(state) }
}

struct IOSServerConnectionStatus: View {
    var showSpinner = true
    var serverName: String?
    @Environment(AppModel.self) private var app
    static func isFirstRun(_ state: ConnectionState) -> Bool { state == .firstRunPending }
    static func isConnecting(_ state: ConnectionState) -> Bool { state == .connecting || state == .idle }
    var body: some View {
        if let warning = app.credentialAccessWarning {
            VStack(alignment: .leading) {
                if let serverName { Text(verbatim: serverName).bold() }
                Label(warning, systemImage: "lock")
                Button(L.t("common_retry")) { Task { await app.retryCredentialAccess() } }
            }.padding().frame(maxWidth: .infinity, alignment: .leading)
                .background(.orange.opacity(0.12)).accessibilityIdentifier("connection-keychain")
        } else if let store = app.store {
            if Self.isConnecting(store.connection) {
                if showSpinner { ProgressView(serverName.map { "\($0): \(L.t("native_ios_connecting"))" } ?? L.t("native_ios_connecting")).padding().accessibilityIdentifier("connection-loading") }
                else if let serverName {
                    Text(verbatim: "\(serverName): \(L.t("native_ios_connecting"))").sessionFont(label: true).padding(8)
                }
            } else if Self.isFirstRun(store.connection) {
                VStack {
                    if let serverName { Text(verbatim: serverName).bold() }
                    Text(verbatim: L.t("native_ios_first_run"))
                    Button(L.t("common_retry")) { app.retry() }.disabled(app.retrying)
                }.padding().accessibilityIdentifier("connection-first-run")
            } else if let banner = BannerPolicy.kind(for: store.connection, lastError: store.lastError,
                serverName: app.activeProfile?.name ?? "", serverVersion: app.serverVersion,
                appVersion: app.appVersion, minClient: app.serverMinClient, serverUnhealthy: app.serverUnhealthy) {
                VStack(alignment: .leading) {
                    if let serverName { Text(verbatim: serverName).bold() }
                    Label(banner.message, systemImage: banner.systemImage)
                    Button(L.t("common_retry")) {
                        if store.connection == .needsLogin, let profile = app.activeProfile { app.sheet = .login(profile) }
                        else { app.retry() }
                    }.disabled(app.retrying)
                }.padding().frame(maxWidth: .infinity, alignment: .leading)
                    .background(.orange.opacity(0.12)).accessibilityIdentifier("connection-banner")
            }
        }
    }
}
