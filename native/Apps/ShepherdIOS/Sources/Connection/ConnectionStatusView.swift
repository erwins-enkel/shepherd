import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct ConnectionStatusView: View {
    @Environment(AppModel.self) private var app
    static func isFirstRun(_ state: ConnectionState) -> Bool { state == .firstRunPending }
    static func isConnecting(_ state: ConnectionState) -> Bool { state == .connecting || state == .idle }
    var body: some View {
        if let store = app.store {
            if Self.isConnecting(store.connection) {
                ProgressView(L.t("native_ios_connecting")).padding().accessibilityIdentifier("connection-loading")
            } else if Self.isFirstRun(store.connection) {
                VStack {
                    Text(verbatim: L.t("native_ios_first_run"))
                    Button(L.t("common_retry")) { app.retry() }.disabled(app.retrying)
                }.padding().accessibilityIdentifier("connection-first-run")
            } else if let banner = BannerPolicy.kind(for: store.connection, lastError: store.lastError,
                serverName: app.activeProfile?.name ?? "", serverVersion: app.serverVersion,
                appVersion: app.appVersion, minClient: app.serverMinClient, serverUnhealthy: app.serverUnhealthy) {
                VStack(alignment: .leading) {
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
