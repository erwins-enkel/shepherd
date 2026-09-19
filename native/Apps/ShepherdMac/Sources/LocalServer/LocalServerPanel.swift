import AppKit
import SwiftUI
import ShepherdKit

/// The panel's enablement rules, separate from the view so they are unit-tested
/// without hosting SwiftUI (pattern: LoginSheetState).
struct LocalServerPanelState: Equatable {
    let state: LocalServerState
    let busy: Bool

    var statusText: String { LocalServerCopy.label(for: state) }
    private var isFailed: Bool { if case .failed = state { return true }; return false }

    var canInstall: Bool { !busy && (state == .notInstalled || isFailed) }
    var canStart: Bool { !busy && (state == .stopped || isFailed) }
    /// Never for `.externallyManaged`: we did not start that process and have no
    /// business killing it.
    var canStop: Bool { !busy && state.isRunning }
    var canRestart: Bool { !busy && state.isRunning }
    var canConnect: Bool { !busy && (state.isRunning || state == .externallyManaged) }
    var isBusyState: Bool { busy || state == .installing || state == .starting }
}

/// Fills `WelcomeSlots.localPanel`: status, the four lifecycle buttons, the
/// one-time password notice and a log disclosure. Renders inside the existing
/// "Run on this Mac" card, which keeps its own title and blurb.
struct LocalServerPanel: View {
    let model: LocalServerModel
    let app: AppModel

    @State private var showingLog = false

    private var panel: LocalServerPanelState {
        LocalServerPanelState(state: model.state, busy: model.busy)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            statusLine
            if let password = model.capturedPassword { passwordNotice(password) }
            controls
            logDisclosure
        }
        .task { await model.refresh() }
        .accessibilityIdentifier("welcome-local-panel")
        .accessibilityElement(children: .contain)
    }

    private var statusLine: some View {
        HStack(spacing: 6) {
            if panel.isBusyState {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: symbol).foregroundStyle(tint)
            }
            Text(verbatim: panel.statusText)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityIdentifier("local-status")
    }

    private var symbol: String {
        switch model.state {
        case .running, .externallyManaged: "checkmark.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        default: "circle"
        }
    }

    private var tint: Color {
        switch model.state {
        case .running, .externallyManaged: .green
        case .failed: .orange
        default: .secondary
        }
    }

    /// Shown once, never persisted (D4). The body names the way back —
    /// SHEPHERD_PASSWORD in ~/.shepherd/env — so dismissing it is not a dead end.
    private func passwordNotice(_ password: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: L.t("native_local_password_title")).font(.callout.weight(.semibold))
            Text(verbatim: L.t("native_local_password_body"))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Text(verbatim: password)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                Button(L.t("native_local_password_copy")) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(password, forType: .string)
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityIdentifier("local-password-notice")
        .accessibilityElement(children: .contain)
    }

    private var controls: some View {
        HStack(spacing: 8) {
            if panel.canInstall {
                Button(L.t("native_local_install")) { Task { await model.install() } }
                    .accessibilityIdentifier("local-install")
            }
            if panel.canStart {
                Button(L.t("native_local_start")) { Task { await model.start() } }
                    .accessibilityIdentifier("local-start")
            }
            if panel.canStop {
                Button(L.t("native_local_stop")) { Task { await model.stop() } }
                    .accessibilityIdentifier("local-stop")
            }
            if panel.canRestart {
                Button(L.t("native_local_restart")) { Task { await model.restart() } }
                    .accessibilityIdentifier("local-restart")
            }
            Spacer(minLength: 8)
            Button(L.t("native_local_connect")) { model.connect(app) }
                .buttonStyle(.borderedProminent)
                .disabled(!panel.canConnect)
                .accessibilityIdentifier("local-connect")
        }
    }

    private var logDisclosure: some View {
        DisclosureGroup(
            isExpanded: $showingLog,
            content: {
                ScrollView {
                    Text(verbatim: model.logLines.joined(separator: "\n"))
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: 160)
                .accessibilityIdentifier("local-log")
            },
            label: {
                Text(verbatim: showingLog ? L.t("native_local_log_hide") : L.t("native_local_log_show"))
                    .font(.caption)
            })
    }
}
