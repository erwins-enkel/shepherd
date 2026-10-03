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
                ServerConnectingView(store: store, server: app.activeProfile?.baseURL.absoluteString)
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

/// The app-wide spinner, plus what it is waiting on once that takes longer than a moment.
/// Its own view so `since` restarts every time connecting does.
private struct ServerConnectingView: View {
    let store: SessionStore
    let server: String?
    @State private var since = Date()

    var body: some View {
        VStack(spacing: 8) {
            ProgressView(L.t("native_ios_connecting")).accessibilityIdentifier("connection-loading")
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
