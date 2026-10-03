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
    @Environment(\.scenePhase) private var scenePhase
    @State private var connecting = ConnectingOverlayDebouncer()
    var inlineActions: AnyView? = nil
    var fixtureClipboard = false
    var fixtureThumbnails: [UUID: UIImage] = [:]

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                surface
                overlay
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
                if allowsInput && !model.showsWriting && !model.dialogOpen {
                    // Only the prompt line summons writing; output remains a terminal surface.
                    Button { model.openWriting(focus: true) } label: { Color.clear.frame(height: 44).contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .accessibilityLabel(L.t("native_ios_terminal_reply"))
                        .accessibilityIdentifier("terminal-prompt-write")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // A Claude dialog is answered with keys; the question keeps the screen.
            if let inlineActions, !(allowsInput && model.dialogOpen) { inlineActions }
            if allowsInput && model.showsReplyBar {
                if model.dialogOpen && !model.showsWriting {
                    IOSTerminalDialogBar(model: model, startTyping: { model.openWriting(focus: true) })
                } else {
                    IOSTerminalReplyBar(model: model, rendersStaticFixture: rendersStaticFixture,
                        steerChips: steerChips, fixtureClipboard: fixtureClipboard, fixtureThumbnails: fixtureThumbnails)
                }
            }
        }
        .accessibilityIdentifier("detail-tab-terminal")
        .onAppear { if !rendersStaticFixture { model.visibilityChanged(visible: true, active: scenePhase == .active) } }
        .onChange(of: scenePhase) { _, phase in
            guard !rendersStaticFixture else { return }
            model.visibilityChanged(visible: true, active: phase == .active)
        }
        .onChange(of: model.session.phase, initial: true) { _, phase in
            connecting.phaseChanged(toConnecting: phase == .connecting)
        }
        .onDisappear {
            guard !rendersStaticFixture else { return }
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
                    } else if closure == .unreachable {
                        Button(L.t("viewport_reconnect_title")) { model.session.takeOver() }
                            .frame(minHeight: 44).accessibilityIdentifier("terminal-retry")
                    }
                }
                if closure == .gone, let error = model.actionState?.error {
                    Text(verbatim: error).accessibilityIdentifier("terminal-recovery-error")
                }
            }
        }
    }

    private func statusCard<Actions: View>(title: String, message: String?,
                                         @ViewBuilder actions: () -> Actions) -> some View {
        Group {
            if rendersStaticFixture { statusContent(title: title, message: message, actions: actions) }
            else { ScrollView { statusContent(title: title, message: message, actions: actions) } }
        }
        .fixedSize(horizontal: false, vertical: true)
        .background(IOSTerminalStyle.panel)
        .overlay(Rectangle().stroke(IOSTerminalStyle.line))
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
