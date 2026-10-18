import SwiftUI
import ShepherdAppCore

/// The reply dock's replacement, shared with static ImageRenderer fixtures.
struct IOSTerminalReconnectPanel: View {
    let phase: IOSReconnectState.Phase
    let serverName: String
    let secondsRemaining: Int
    let lastContact: Date?
    var retry: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    private var checking: Bool { phase == .checking }
    private var title: String {
        switch phase {
        case .checking: L.t("native_ios_reconnect_connecting", serverName)
        case .failed: L.t("native_ios_reconnect_failed")
        default: L.t("native_ios_reconnect_unreachable", serverName)
        }
    }
    private var buttonLabel: String {
        L.t(checking ? "native_ios_reconnect_checking" : phase == .failed ? "native_ios_reconnect_try_again" : "native_ios_reconnect_check")
    }
    private var message: String {
        if phase == .failed { return L.t("native_ios_reconnect_awake", serverName) }
        return L.t("native_ios_reconnect_locked") + (lastContact.map { " " + L.t("native_ios_reconnect_last_contact", Self.time($0)) } ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if typeSize.isAccessibilitySize {
                symbol
                explanation
            } else {
                HStack(alignment: .top, spacing: 12) { symbol; explanation }
            }
            Button(action: retry) {
                HStack(spacing: 8) {
                    if checking { ProgressView().tint(IOSTerminalStyle.amber).accessibilityHidden(true) }
                    else { Image(systemName: "arrow.clockwise").accessibilityHidden(true) }
                    Text(verbatim: buttonLabel).fixedSize(horizontal: false, vertical: true)
                }
                .font(.system(.callout, design: .monospaced).weight(.semibold))
                .padding(.horizontal, 16).padding(.vertical, 12)
                .frame(maxWidth: .infinity, minHeight: 52)
                .background(IOSTerminalStyle.amber.opacity(checking ? 0.04 : 0.12), in: Capsule())
                .overlay(Capsule().stroke(IOSTerminalStyle.amber.opacity(checking ? 0.25 : 0.8)))
                .foregroundStyle(IOSTerminalStyle.amber)
            }
            .buttonStyle(.plain).disabled(checking)
            .accessibilityLabel(buttonLabel)
            .accessibilityIdentifier("terminal-reconnect")
            if !checking {
                Label(L.t("native_ios_reconnect_countdown", String(secondsRemaining)), systemImage: "clock")
                    .font(.system(.caption, design: .monospaced)).monospacedDigit()
                    .foregroundStyle(IOSTerminalStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .center)
                    // Queryable on focus, never a live announcement every second.
                    .accessibilityHidden(false)
                    .accessibilityAddTraits(.updatesFrequently)
                    .accessibilityIdentifier("terminal-reconnect-countdown")
            }
        }
        .padding(16)
        .background(IOSTerminalStyle.panel, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(IOSTerminalStyle.line))
        .padding(12)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("terminal-reconnect-panel")
    }

    private var symbol: some View {
        ZStack {
            Circle().fill((checking ? IOSTerminalStyle.amber : SessionListStyle.red).opacity(0.12))
            if checking { ProgressView().tint(IOSTerminalStyle.amber) }
            else { Image(systemName: phase == .failed ? "exclamationmark.circle" : "wifi.slash").foregroundStyle(SessionListStyle.red) }
        }.frame(width: 44, height: 44).accessibilityHidden(true)
    }
    private var explanation: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: title).font(.system(.headline, design: .monospaced)).foregroundStyle(IOSTerminalStyle.ink)
            Text(verbatim: message).font(.system(.callout, design: .monospaced)).foregroundStyle(IOSTerminalStyle.muted)
        }.fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
    }

    static func time(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }
}

struct IOSTerminalConnectionBadge: View {
    var lastContact: Date?
    var reconnected = false
    var body: some View {
        Label(text, systemImage: reconnected ? "checkmark.circle" : "clock")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(reconnected ? SessionListStyle.green : IOSTerminalStyle.muted)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(IOSTerminalStyle.panel, in: Capsule())
            .overlay(Capsule().stroke(reconnected ? SessionListStyle.green.opacity(0.4) : IOSTerminalStyle.line))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(reconnected ? "terminal-reconnected" : "terminal-not-live")
    }
    private var text: String {
        if reconnected { return L.t("native_ios_reconnect_reconnected") }
        return lastContact.map { L.t("native_ios_reconnect_not_live_at", IOSTerminalReconnectPanel.time($0)) }
            ?? L.t("native_ios_reconnect_not_live")
    }
}
