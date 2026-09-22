import ShepherdAppCore
import AppKit
import SwiftUI
import ShepherdKit

/// The panel's enablement rules, separate from the view so they are unit-tested
/// without hosting SwiftUI (pattern: LoginSheetState).
struct LocalServerPanelState: Equatable {
    let state: LocalServerState
    let busy: Bool
    var externalAcknowledged = false

    var statusText: String { LocalServerCopy.label(for: state) }
    private var isFailed: Bool { if case .failed = state { return true }; return false }

    /// M-2: which lifecycle button occupies each row position, fixed by
    /// `state` alone — never by `busy`. `install()` sets `state` to
    /// `.installing` itself before its awaited work starts, so Install stays
    /// on that condition through the whole action; `act()` (start/stop/
    /// restart's shared path) does not touch `state` until the action
    /// finishes, so Start/Stop/Restart are already stable on the pre-action
    /// state without needing `.starting`/`state.isRunning` special-cased here
    /// — a `refresh()` can also observe `.starting` mid-flight from elsewhere,
    /// which Start covers the same way. `.disabled(...)` is what gates
    /// interaction; presence must never flicker with it.
    var showsInstall: Bool { state == .notInstalled || state == .installing || isFailed }
    var showsStart: Bool { state == .stopped || state == .starting || isFailed }
    /// Never for `.externallyManaged`: we did not start that process and have no
    /// business killing it.
    var showsStop: Bool { state.isRunning }
    var showsRestart: Bool { state.isRunning }

    var canInstall: Bool { !busy && showsInstall }
    var canStart: Bool { !busy && showsStart }
    var canStop: Bool { !busy && showsStop }
    var canRestart: Bool { !busy && showsRestart }
    var canConnect: Bool { !busy && (state.isRunning || (state == .externallyManaged && externalAcknowledged)) }
    var isBusyState: Bool { busy || state == .installing || state == .starting }
}

/// Fills `WelcomeSlots.localPanel`: status, the four lifecycle buttons, the
/// one-time password notice and a log disclosure. Renders inside the existing
/// "Run on this Mac" card, which keeps its own title and blurb.
struct LocalServerPanel: View {
    let model: LocalServerModel
    let app: AppModel
    var onConnect: (() -> Void)? = nil

    @State private var showingLog = false

    private var panel: LocalServerPanelState {
        LocalServerPanelState(state: model.state, busy: model.busy, externalAcknowledged: model.externalAcknowledged)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            statusLine
            if model.state == .externallyManaged { externalNotice }
            if let failure = model.runnerFailure {
                Text(verbatim: LocalServerCopy.message(for: failure)).font(.callout).foregroundStyle(.orange)
            }
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
        case .running: "checkmark.circle.fill"
        case .externallyManaged: "exclamationmark.triangle.fill"
        case .failed: "exclamationmark.triangle.fill"
        default: "circle"
        }
    }

    private var tint: Color {
        switch model.state {
        case .running: .green
        case .externallyManaged: .orange
        case .failed: .orange
        default: .secondary
        }
    }

    private var externalNotice: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: L.t("native_local_external_title")).font(.callout.weight(.semibold))
                .accessibilityIdentifier("local-external-title")
            Text(verbatim: L.t("native_local_external_summary"))
                .font(.caption).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("local-external-summary")
            Text(verbatim: L.t("native_local_external_app", model.externalIdentity?.appDirectory ?? L.t("native_local_path_unknown")))
                .font(.caption).textSelection(.enabled)
            Text(verbatim: L.t("native_local_external_database", model.externalIdentity?.databasePath ?? L.t("native_local_path_unknown")))
                .font(.caption).textSelection(.enabled)
            if !model.externalAcknowledged {
                Button(L.t("native_local_external_keep"), action: model.acknowledgeExternalServer)
                    .disabled(model.busy).accessibilityIdentifier("local-external-keep")
            }
            DisclosureGroup(L.t("native_local_external_stop_title")) {
                Text(verbatim: L.t("native_local_external_stop_body"))
                    .font(.caption).fixedSize(horizontal: false, vertical: true)
                Button(L.t("native_local_recheck")) { Task { await model.refresh() } }
                    .disabled(model.busy).accessibilityIdentifier("local-external-recheck")
            }
        }
        .padding(10)
        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    /// Shown once, never persisted (D4). The body names the way back —
    /// SHEPHERD_PASSWORD in ~/.shepherd/env — so dismissing it is not a dead end.
    ///
    /// V2: this used to stay on screen for the whole run — nothing ever
    /// cleared `capturedPassword` short of `connect()`. The explicit dismiss
    /// (X) and Copy are both one-shot now: either one is "I've dealt with
    /// this", so both route through `dismissCapturedPassword()`. Pattern for
    /// the dismiss control: `NoticeBar` in `MainWindow.swift`.
    private func passwordNotice(_ password: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: L.t("native_local_password_title")).font(.callout.weight(.semibold))
                Spacer(minLength: 8)
                Button(L.t("common_close"), systemImage: "xmark", action: model.dismissCapturedPassword)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("local-server-password-dismiss")
            }
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
                    model.dismissCapturedPassword()
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("local-server-password-copy")
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityIdentifier("local-password-notice")
        .accessibilityElement(children: .contain)
    }

    /// M-2: every button's presence is keyed by `panel.showsX` (state alone),
    /// never by `panel.canX` (which also folds in `busy`) — otherwise the row
    /// goes empty for the whole span of an action instead of merely disabling
    /// the button that started it. The accessibility identifiers therefore
    /// stay reachable throughout a transition too.
    private var controls: some View {
        HStack(spacing: 8) {
            if panel.showsInstall {
                // `beginInstall()`, not a bare `Task`: the model keeps the
                // handle so the quit path can cancel the installer.
                Button(L.t("native_local_install")) { model.beginInstall() }
                    .disabled(!panel.canInstall)
                    .accessibilityIdentifier("local-install")
            }
            if panel.showsStart {
                Button(L.t("native_local_start")) { Task { await model.start() } }
                    .disabled(!panel.canStart)
                    .accessibilityIdentifier("local-start")
            }
            if panel.showsStop {
                Button(L.t("native_local_stop")) { Task { await model.stop() } }
                    .disabled(!panel.canStop)
                    .accessibilityIdentifier("local-stop")
            }
            if panel.showsRestart {
                Button(L.t("native_local_restart")) { Task { await model.restart() } }
                    .disabled(!panel.canRestart)
                    .accessibilityIdentifier("local-restart")
            }
            Spacer(minLength: 8)
            Button(L.t("native_local_connect")) {
                if let onConnect { onConnect() } else { model.connect(app) }
            }
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
