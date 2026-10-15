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
                        serverName: hub.profiles.first { $0.id == id }?.name,
                        unavailable: hub.unavailableIDs.contains(id),
                        showsUnavailableNotice: hub.showsUnavailableNotice(id),
                        dismissUnavailable: { hub.dismissUnavailableNotice(id) }, profileID: id).environment(model)
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
    var unavailable = false
    var showsUnavailableNotice = false
    var dismissUnavailable: () -> Void = {}
    var profileID: UUID?
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(AppModel.self) private var app
    static func isFirstRun(_ state: ConnectionState) -> Bool { state == .firstRunPending }
    static func isConnecting(_ state: ConnectionState) -> Bool { state == .connecting || state == .idle }
    var body: some View {
        if showsUnavailableNotice {
            VStack(alignment: .leading, spacing: 4) {
                if typeSize.isAccessibilitySize {
                    unavailableMessage
                    unavailableActions
                } else {
                    HStack(spacing: 8) { unavailableMessage; unavailableActions }
                }
            }.sessionFont(label: true).padding(.horizontal, 10)
                .foregroundStyle(SessionListStyle.ink).background(.orange.opacity(0.12))
                .accessibilityIdentifier("connection-unavailable-\(profileID?.uuidString ?? "server")")
        } else if let warning = app.credentialAccessWarning {
            VStack(alignment: .leading) {
                if let serverName { Text(verbatim: serverName).bold() }
                Label(warning, systemImage: "lock")
                Button(L.t("common_retry")) { Task { await app.retryCredentialAccess() } }
            }.padding().frame(maxWidth: .infinity, alignment: .leading)
                .background(.orange.opacity(0.12)).accessibilityIdentifier("connection-keychain")
        } else if let store = app.store {
            if unavailable {
                // Closing an outage also hides its reconnect line until recovery.
            } else if Self.isConnecting(store.connection) {
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
    private var unavailableMessage: some View {
        Label(L.t("native_ios_server_unavailable", serverName ?? app.activeProfile?.name ?? ""), systemImage: "wifi.slash")
            .frame(maxWidth: .infinity, alignment: .leading)
    }
    private var unavailableActions: some View {
        HStack(spacing: 8) {
            Button(L.t("common_retry")) { app.retry() }.disabled(app.retrying)
                .frame(minWidth: 44, minHeight: 44)
                .accessibilityIdentifier("connection-unavailable-retry-\(profileID?.uuidString ?? "server")")
            if typeSize.isAccessibilitySize { Spacer() }
            Button(action: dismissUnavailable) { Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44) }
                .accessibilityLabel(L.t("common_close"))
                .accessibilityIdentifier("connection-unavailable-close-\(profileID?.uuidString ?? "server")")
        }
    }
}
