import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// The terminal tab's body: the emulator, a state overlay, and saved steers.
struct TerminalPane: View {
    @Bindable var model: TerminalSessionModel
    let store: SessionStore
    let sessionID: String
    let app: AppModel
    let activation: Int
    /// Set for a session mirrored from a connected machine (#2768): its terminal is bridged
    /// through this server, but its steers and recovery belong to that machine.
    var machine: SessionHost? = nil
    @State private var focusRequest = 0
    /// Debounces the `.connecting` card; see its own doc comment.
    @State private var connectingOverlay = ConnectingOverlayDebouncer()

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                TerminalHostView(model: model, focusRequest: focusRequest)
                    .accessibilityLabel(machine.map { L.t("remote_terminal_aria", $0.name) }
                        ?? L.t("native_terminal_tab_title"))
                overlay
            }
            // Saved steers go through this server's `/reply`, which a mirrored session has not.
            if machine == nil {
                Divider()
                TerminalSteerFooter(store: store, sessionID: sessionID, app: app, activation: activation)
            }
        }
        // The tab-body identifier every other detail tab carries (`detail-tab-activity`,
        // `-diff`, `-files`, `-git`, `-prompt`). The tab BUTTONS carry no accessibility name on
        // this toolchain — SwiftUI's `TabView` becomes an `NSTabView` — so a body identifier is
        // the only stable handle a test has on "the terminal tab is what is showing". The
        // pane's own controls keep their `terminal-*` identifiers; this names the tab, not them.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("detail-tab-terminal")
        .onAppear { focusRequest += 1 }
        .onDisappear { model.detach() }
        .onChange(of: model.phase, initial: true) { _, phase in
            connectingOverlay.phaseChanged(toConnecting: phase == .connecting)
        }
    }

    @ViewBuilder
    private var overlay: some View {
        switch model.phase {
        case .idle, .live:
            EmptyView()
        case .connecting:
            if connectingOverlay.isVisible {
                statusCard(
                    title: L.t("native_terminal_connecting"), body: nil, action: nil,
                    systemImage: nil)
            } else {
                EmptyView()
            }
        case .superseded:
            statusCard(
                title: TerminalOwnerCopy.title(owners: store.terminalOwners, sessionID: sessionID),
                body: L.t("native_terminal_superseded_body"),
                action: (L.t("native_terminal_superseded_action"), { model.takeOver() }),
                systemImage: "display.2"
            )
        case .ended(let closure):
            endedCard(for: closure)
        }
    }

    /// `TerminalSessionModel.apply(_:)` routes `.closed(.superseded)` to
    /// `.superseded` and `.closed(.stopped)` to `.idle` before a `.closed`
    /// event ever reaches the generic `.ended(closure)` phase — so only
    /// `.gone`, `.unreachable` and, for a mirrored session's bridged terminal,
    /// `.machineUnreachable` are actually reachable here. `default`
    /// (rather than naming `.superseded`/`.stopped` again) keeps this switch
    /// exhaustive over `PTYConnection.Closure` without implying either one can
    /// happen.
    @ViewBuilder
    private func endedCard(for closure: PTYConnection.Closure) -> some View {
        if let machine, closure == .machineUnreachable {
            // Reopens by itself once the machine is back (`machineConnectionChanged`).
            statusCard(
                title: L.t("native_remote_terminal_lost_title", machine.name),
                body: L.t("native_remote_terminal_lost_body", machine.name),
                action: (L.t("native_recovery_reopen"), { model.takeOver() }),
                systemImage: "network.slash")
        } else if let machine, closure == .gone {
            // Resuming is that machine's to do; nothing here may start the agent instead.
            statusCard(
                title: L.t("native_terminal_ended_title"),
                body: L.t("native_remote_terminal_ended_body", machine.name),
                action: nil, systemImage: nil)
        } else {
            localEndedCard(for: closure)
        }
    }

    @ViewBuilder
    private func localEndedCard(for closure: PTYConnection.Closure) -> some View {
        VStack(spacing: 8) {
            BackendRecoveryPanel(failure: closure == .gone ? .sessionGone : model.recoveryFailure,
                reopen: {
                    if closure == .gone { Task { await model.recoverGoneSession() } }
                    else { model.takeOver() }
                })
                .disabled(model.sessionRecoveryBusy)
            if model.sessionRecoveryBusy { ProgressView() }
            if let error = model.sessionRecoveryError {
                Text(verbatim: error).foregroundStyle(.red)
                    .accessibilityIdentifier("terminal-recovery-error")
            }
        }
    }

    /// A descriptive title, one short explanatory sentence, and the one next
    /// step — the house rule for explanatory surfaces.
    private func statusCard(
        title: String,
        body: String?,
        action: (label: String, run: () -> Void)?,
        systemImage: String?
    ) -> some View {
        VStack(spacing: 10) {
            if let systemImage {
                Image(systemName: systemImage).font(.largeTitle).foregroundStyle(.secondary)
            }
            Text(verbatim: title).font(.headline)
            if let body {
                Text(verbatim: body)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let action {
                // One identifier for both recoveries: each one is the operator
                // reclaiming the terminal, and only one is ever on screen.
                Button(action.label, action: action.run)
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("terminal-takeover")
            }
        }
        .padding(24)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .shadow(radius: 8)
    }

}
