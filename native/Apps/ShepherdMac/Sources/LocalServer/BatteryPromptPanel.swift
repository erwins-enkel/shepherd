import AppKit
import ShepherdAppCore
import SwiftUI

/// A decision surface, not a notification: no timeout, close button or Escape dismissal.
@MainActor final class BatteryPromptPanel: NSPanel {
    init(model: BatteryPauseModel) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 440, height: 300),
                   styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        title = L.t("native_battery_title")
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        isFloatingPanel = true
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isMovable = false
        contentView = NSHostingView(rootView: BatteryPromptView(model: model))
        setAccessibilityIdentifier("battery-decision-panel")
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) {}

    func position() {
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main else { return }
        let bounds = screen.visibleFrame
        setFrameTopLeftPoint(NSPoint(x: bounds.maxX - frame.width - 20, y: bounds.maxY - 20))
    }

    func show() {
        if let contentView { setContentSize(contentView.fittingSize) }
        guard !isVisible else { return }
        position()
        orderFrontRegardless() // Never activate Shepherd or steal the current typing focus.
    }
}

private struct BatteryPromptView: View {
    let model: BatteryPauseModel
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label(L.t("native_battery_title"), systemImage: "battery.50percent")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.orange)
            Text(L.t("native_battery_body"))
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
            if let error = model.error {
                Text(verbatim: error).font(.callout).foregroundStyle(.red)
            }
            VStack(spacing: 10) {
                Button(L.t("native_battery_pause")) { model.pauseUntilPower() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.canPause)
                    .accessibilityIdentifier("battery-pause")
                Button(L.t("native_battery_continue")) { model.keepRunning() }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("battery-continue")
            }
            .controlSize(.large)
            .frame(maxWidth: .infinity)
        }
        .padding(28)
        .frame(width: 440)
        .background(.regularMaterial)
    }
}

struct BatteryPauseStatus: View {
    private var model: BatteryPauseModel { .shared }
    var body: some View {
        if model.isActive {
            HStack(spacing: 12) {
                Label(L.t(model.phase == .paused ? "native_battery_paused" : "native_battery_changing"), systemImage: "pause.circle.fill")
                Spacer()
                Button(L.t("native_battery_resume")) { model.resumeNow() }
                    .disabled(model.phase == .pausing)
            }
            .padding(12)
            .background(.orange.opacity(0.12))
            .accessibilityIdentifier("battery-pause-status")
        }
    }
}
