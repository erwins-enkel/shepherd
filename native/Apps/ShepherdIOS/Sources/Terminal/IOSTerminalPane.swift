import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// Shared chrome accepts a surface so ImageRenderer fixtures exercise the real layout.
struct IOSTerminalPane<Surface: View>: View {
    let model: IOSTerminalPresentation
    let allowsInput: Bool
    let surface: Surface
    @Binding var fontSize: Double
    @Environment(\.scenePhase) private var scenePhase
    @State private var connecting = ConnectingOverlayDebouncer()
    @State private var fontSettings = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                if !model.followsTail {
                    Button { model.jumpToTail() } label: {
                        Label(L.t("native_ios_terminal_latest"), systemImage: "arrow.down.to.line")
                    }.accessibilityIdentifier("terminal-jump-to-tail")
                }
                Spacer(minLength: 0)
                Button { fontSettings = true } label: {
                    Image(systemName: "textformat.size").frame(width: 44, height: 44)
                }
                .accessibilityLabel(L.t("native_ios_terminal_font_size"))
                .accessibilityIdentifier("terminal-font-settings")
                .popover(isPresented: $fontSettings) {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(L.t("native_ios_terminal_font_size"))
                        Slider(value: $fontSize, in: 9...24, step: 1)
                            .accessibilityLabel(L.t("native_ios_terminal_font_size"))
                            .accessibilityValue(L.t("native_ios_terminal_font_points", Int(fontSize)))
                        Text(verbatim: L.t("native_ios_terminal_font_points", Int(fontSize)))
                            .monospacedDigit()
                    }
                    .font(.system(.body, design: .monospaced))
                    .padding().frame(minWidth: 260)
                    .presentationCompactAdaptation(.popover)
                }
            }
            .font(.system(.caption, design: .monospaced))
            .padding(.horizontal, 12)
            .background(IOSTerminalStyle.panel)
            Rectangle().fill(IOSTerminalStyle.line).frame(height: 1)
            ZStack {
                surface
                overlay
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .accessibilityIdentifier("detail-tab-terminal")
        .onAppear { model.visibilityChanged(visible: true, active: scenePhase == .active) }
        .onChange(of: scenePhase) { _, phase in
            model.visibilityChanged(visible: true, active: phase == .active)
        }
        .onChange(of: model.session.phase, initial: true) { _, phase in
            connecting.phaseChanged(toConnecting: phase == .connecting)
        }
        .onDisappear {
            model.visibilityChanged(visible: false, active: false)
            connecting.phaseChanged(toConnecting: false)
        }
    }

    @ViewBuilder private var overlay: some View {
        switch model.session.phase {
        case .idle, .live: EmptyView()
        case .connecting:
            if connecting.isVisible {
                statusCard(title: L.t("native_terminal_connecting"), message: nil) {
                    ProgressView().tint(IOSTerminalStyle.ink)
                }
            }
        case .superseded:
            statusCard(title: L.t("native_terminal_superseded_title"),
                message: L.t("native_ios_terminal_superseded_body")) {
                if allowsInput {
                    Button(L.t("native_terminal_superseded_action")) { model.session.takeOver() }
                        .frame(minHeight: 44).accessibilityIdentifier("terminal-take-over")
                }
            }
        case .ended(let closure):
            statusCard(
                title: L.t(closure == .gone ? "native_terminal_ended_title" : "native_terminal_unreachable_title"),
                message: L.t(closure == .gone ? "native_terminal_ended_body" : "native_terminal_unreachable_body")) {
                if allowsInput {
                    Button(L.t("common_retry")) {
                        if closure == .gone { Task { await model.session.recoverGoneSession() } }
                        else { model.session.takeOver() }
                    }
                    .frame(minHeight: 44).disabled(model.session.sessionRecoveryBusy)
                    .accessibilityIdentifier("terminal-retry")
                }
                if let error = model.session.sessionRecoveryError {
                    Text(verbatim: error).accessibilityIdentifier("terminal-recovery-error")
                }
            }
        }
    }

    private func statusCard<Actions: View>(title: String, message: String?,
                                         @ViewBuilder actions: () -> Actions) -> some View {
        ScrollView {
            VStack(spacing: 12) {
                Text(verbatim: title).font(.system(.headline, design: .monospaced))
                if let message { Text(verbatim: message).font(.system(.callout, design: .monospaced)) }
                actions()
            }.multilineTextAlignment(.center).padding(20)
        }
        .fixedSize(horizontal: false, vertical: true)
        .background(IOSTerminalStyle.panel)
        .overlay(Rectangle().stroke(IOSTerminalStyle.line))
        .padding(20)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("terminal-state-overlay")
    }
}
