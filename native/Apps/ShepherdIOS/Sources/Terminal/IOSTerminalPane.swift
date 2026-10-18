import ShepherdAppCore
import ShepherdKit
import SwiftUI
import UIKit

/// Shared chrome accepts a surface so ImageRenderer fixtures exercise the real layout.
struct IOSTerminalPane<Surface: View>: View {
    let model: IOSTerminalPresentation
    let allowsInput: Bool
    let surface: Surface
    @Binding var fontSize: Double
    var rendersStaticFixture = false
    /// Saved steers above the reply draft; nil in fixtures and read-only launches.
    var steerChips: AnyView? = nil
    @Environment(AppModel.self) private var app: AppModel?
    @Environment(IOSServerHub.self) private var hub: IOSServerHub?
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.scenePhase) private var scenePhase
    @State private var connecting = ConnectingOverlayDebouncer()
    var inlineActions: AnyView? = nil
    var fixtureClipboard = false
    var fixtureThumbnails: [UUID: UIImage] = [:]
    var latency: IOSLatencyMonitor? = nil
    var reconnectFixture: IOSReconnectState? = nil
    var fixtureServerName: String? = nil

    private var recovery: IOSReconnectState? { reconnectFixture ?? model.connection?.retry }
    private var locked: Bool { model.inputLocked || (recovery.map { $0.phase != .connected } ?? false) }
    private var serverName: String { app?.activeProfile?.name ?? fixtureServerName ?? L.t("native_ios_latency_server") }

    var body: some View {
        VStack(spacing: 0) {
            if locked && typeSize.isAccessibilitySize {
                IOSTerminalConnectionBadge(lastContact: recovery?.lastContact).padding(10)
            }
            ZStack {
                surface.opacity(locked ? 0.45 : 1)
                overlay
            }
            .frame(maxWidth: .infinity, maxHeight: locked && typeSize.isAccessibilitySize ? 160 : .infinity)
            .overlay(alignment: .top) {
                if locked && !typeSize.isAccessibilitySize {
                    IOSTerminalConnectionBadge(lastContact: recovery?.lastContact).padding(10)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !model.followsTail {
                    Button { model.jumpToTail() } label: {
                        Label(L.t("native_ios_terminal_latest"), systemImage: "arrow.down.to.line")
                            .font(.system(.caption, design: .monospaced))
                            .padding(.horizontal, 12).frame(minHeight: 36)
                            .background(IOSTerminalStyle.panel, in: Capsule())
                            .overlay(Capsule().stroke(IOSTerminalStyle.line))
                    }
                    .buttonStyle(.plain).foregroundStyle(IOSTerminalStyle.amber)
                    .frame(minHeight: 44).padding(10)
                    .accessibilityIdentifier("terminal-jump-to-tail")
                }
            }
            .simultaneousGesture(TapGesture().onEnded { model.closeWriting() }, including: model.writing ? .all : .none)
            .overlay(alignment: .bottom) {
                // An open dialog's last line is its footer, not the prompt: ⌨ in the key row writes.
                if allowsInput && !locked && !model.showsWriting && !model.dialogOpen {
                    // Only the prompt line summons writing; output remains a terminal surface.
                    Button { model.openWriting(focus: true) } label: { Color.clear.frame(height: 44).contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .accessibilityLabel(L.t("native_ios_terminal_reply"))
                        .accessibilityIdentifier("terminal-prompt-write")
                }
            }
            // A Claude dialog is answered with keys; the question keeps the screen.
            if locked {
                if typeSize.isAccessibilitySize {
                    ScrollView { reconnectPanel }.frame(maxHeight: .infinity)
                } else { reconnectPanel }
            } else {
                if let inlineActions, !(allowsInput && model.dialogOpen) { inlineActions }
                if recovery?.showsReconnected == true {
                    IOSTerminalConnectionBadge(reconnected: true).padding(.top, 8)
                }
            }
            if !locked && allowsInput && model.showsReplyBar {
                if model.answersWithKeys {
                    IOSTerminalDialogBar(model: model, startTyping: { model.openWriting(focus: true) })
                } else {
                    IOSTerminalReplyBar(model: model, rendersStaticFixture: rendersStaticFixture,
                        steerChips: steerChips, fixtureClipboard: fixtureClipboard, fixtureThumbnails: fixtureThumbnails)
                }
            }
        }
        .accessibilityIdentifier("detail-tab-terminal")
        .onAppear {
            guard !rendersStaticFixture else { return }
            if let app {
                if model.connection == nil {
                    model.connection = IOSTerminalConnection(app: app, hub: hub, terminal: model, latency: latency)
                } else { model.connection?.latency = latency }
                model.connection?.update()
                recovery?.appear(active: scenePhase == .active)
            }
            model.visibilityChanged(visible: true, active: scenePhase == .active)
        }
        .onChange(of: model.isUnreachable) { _, _ in model.connection?.update() }
        .onChange(of: latency?.report) { _, _ in
            model.connection?.latency = latency
            model.connection?.update()
        }
        .onChange(of: scenePhase) { _, phase in
            guard !rendersStaticFixture else { return }
            recovery?.setRunning(phase == .active)
            model.visibilityChanged(visible: true, active: phase == .active)
        }
        .onChange(of: model.session.phase, initial: true) { _, phase in
            connecting.phaseChanged(toConnecting: phase == .connecting)
            if !rendersStaticFixture { model.connection?.update() }
        }
        .onDisappear {
            guard !rendersStaticFixture else { return }
            recovery?.setRunning(false)
            model.visibilityChanged(visible: false, active: false)
            connecting.phaseChanged(toConnecting: false)
        }
    }

    private var reconnectPanel: some View {
        IOSTerminalReconnectPanel(phase: recovery?.phase == .connected ? .offline : recovery?.phase ?? .offline,
            serverName: serverName, secondsRemaining: recovery?.secondsRemaining ?? 30,
            lastContact: recovery?.lastContact, retry: { recovery?.retry() })
    }

    @ViewBuilder private var overlay: some View {
        switch model.session.phase {
        case .idle, .live: EmptyView()
        case .connecting:
            if connecting.isVisible && !locked {
                statusCard(title: L.t("native_terminal_connecting"), message: nil) {
                    ProgressView().tint(IOSTerminalStyle.ink)
                }
            }
        case .superseded:
            ZStack {
                Color.black.opacity(0.55).ignoresSafeArea()
                statusCard(title: L.t("native_terminal_superseded_title"),
                    message: L.t("native_ios_terminal_superseded_body"), emphasized: true) {
                    if allowsInput {
                        Button(L.t("native_terminal_superseded_action")) { model.session.takeOver() }
                            .frame(minHeight: 44).accessibilityIdentifier("terminal-take-over")
                    }
                }
            }
        case .ended(.unreachable): EmptyView()
        case .ended(let closure):
            statusCard(
                title: L.t(closure == .gone ? "native_terminal_ended_title" : "native_terminal_unreachable_title"),
                message: L.t(closure == .gone && model.canResume ? "viewport_resume_sub" : closure == .gone ? "native_terminal_ended_body" : "viewport_reconnect_sub")) {
                if allowsInput && model.allowsInput {
                    if closure == .gone, model.canResume {
                        Button { Task { await model.resume() } } label: {
                            HStack {
                                if model.actionState?.busy == true { ProgressView() }
                                Text(L.t(model.actionState?.busy == true ? "common_loading" : "viewport_resume_title"))
                            }
                        }
                        .buttonStyle(IOSActionButtonStyle())
                        .frame(minHeight: 44).disabled(model.actionState?.busy == true)
                        .accessibilityIdentifier("terminal-resume")
                    }
                }
                if closure == .gone, let error = model.actionState?.error {
                    Text(verbatim: error).accessibilityIdentifier("terminal-recovery-error")
                }
            }
        }
    }

    private func statusCard<Actions: View>(title: String, message: String?, emphasized: Bool = false,
                                         @ViewBuilder actions: () -> Actions) -> some View {
        Group {
            if rendersStaticFixture { statusContent(title: title, message: message, actions: actions) }
            else { ScrollView { statusContent(title: title, message: message, actions: actions) } }
        }
        .fixedSize(horizontal: false, vertical: true)
        .background(IOSTerminalStyle.panel)
        .overlay(Rectangle().stroke(emphasized ? IOSTerminalStyle.amber.opacity(0.8) : IOSTerminalStyle.line,
            lineWidth: emphasized ? 2 : 1))
        .shadow(color: emphasized ? Color.black.opacity(0.65) : .clear, radius: 16, y: 8)
        .padding(20)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("terminal-state-overlay")
    }

    private func statusContent<Actions: View>(title: String, message: String?,
                                            @ViewBuilder actions: () -> Actions) -> some View {
        VStack(spacing: 12) {
            Text(verbatim: title).font(.system(.headline, design: .monospaced))
            if let message { Text(verbatim: message).font(.system(.callout, design: .monospaced)) }
            actions()
        }.multilineTextAlignment(.center).padding(20)
    }
}

struct IOSTerminalFontSettings: View {
    @Binding var fontSize: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L.t("native_ios_terminal_font_size"))
            Slider(value: $fontSize, in: 9...24, step: 1)
                .accessibilityLabel(L.t("native_ios_terminal_font_size"))
                .accessibilityValue(L.t("native_ios_terminal_font_points", String(Int(fontSize))))
            Text(verbatim: L.t("native_ios_terminal_font_points", String(Int(fontSize))))
                .monospacedDigit()
        }
        .font(.system(.body, design: .monospaced))
        .padding().frame(minWidth: 260)
    }
}
