import AppKit
import ShepherdAppCore
import SwiftUI

/// A decision surface, not a notification: no timeout, close button or Escape dismissal.
@MainActor final class BatteryPromptPanel: NSPanel {
    init(model: BatteryPauseModel) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 400, height: 220),
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
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: "battery.50percent")
                    .font(.title2)
                    .foregroundStyle(.orange)
                    .frame(width: 40, height: 40)
                    .background(.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(L.t("native_battery_title"))
                        .font(.headline)
                        .accessibilityAddTraits(.isHeader)
                    Text(L.t("native_battery_body"))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Label(L.t("native_battery_hint"), systemImage: "powerplug")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
            if let error = model.error {
                Label { Text(verbatim: error) } icon: { Image(systemName: "exclamationmark.circle") }
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                Spacer()
                Button(L.t("native_battery_continue")) { model.keepRunning() }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("battery-continue")
                Button(L.t("native_battery_pause")) { model.pauseUntilPower() }
                    .buttonStyle(.borderedProminent)
                    .tint(.orange)
                    .disabled(!model.canPause)
                    .accessibilityIdentifier("battery-pause")
            }
        }
        .padding(20)
        .frame(width: 400)
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
