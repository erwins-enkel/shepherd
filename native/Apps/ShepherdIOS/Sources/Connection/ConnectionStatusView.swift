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
                ServerConnectingView(store: store, server: app.activeProfile?.baseURL.absoluteString,
                    showSpinner: showSpinner, serverName: serverName)
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

/// The app-wide spinner, plus what it is waiting on once that takes longer than a moment.
/// Its own view so `since` restarts every time connecting does.
private struct ServerConnectingView: View {
    let store: SessionStore
    let server: String?
    let showSpinner: Bool
    let serverName: String?
    @State private var since = Date()

    var body: some View {
        VStack(spacing: 8) {
            if showSpinner {
                ProgressView(serverName.map { "\($0): \(L.t("native_ios_connecting"))" } ?? L.t("native_ios_connecting"))
                    .accessibilityIdentifier("connection-loading")
            } else if let serverName {
                Text(verbatim: "\(serverName): \(L.t("native_ios_connecting"))").sessionFont(label: true)
            }
            TimelineView(.periodic(from: since, by: 1)) { context in
                let elapsed = context.date.timeIntervalSince(since)
                if elapsed >= ConnectingDetailCopy.threshold {
                    IOSConnectingDetails(rows: ConnectingDetailCopy.serverRows(
                        server: server, detail: store.connection == .connecting ? store.connectingDetail : nil,
                        elapsed: elapsed, now: context.date))
                }
            }
        }.padding()
    }
}

/// Label/value lines that say where a slow connect is stuck. Selectable, so a URL
/// or an error can be copied into a bug report.
struct IOSConnectingDetails: View {
    let rows: [ConnectingDetailRow]

    var body: some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 4) {
            ForEach(rows, id: \.self) { row in
                GridRow {
                    Text(verbatim: row.label).foregroundStyle(IOSTerminalStyle.muted)
                    Text(verbatim: row.value).foregroundStyle(IOSTerminalStyle.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .font(.system(.caption, design: .monospaced))
        .multilineTextAlignment(.leading)
        .textSelection(.enabled)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("connecting-details")
    }
}
