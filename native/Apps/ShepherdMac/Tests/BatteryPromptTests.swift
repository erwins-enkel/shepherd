import AppKit
import Testing
import ShepherdKit
@testable import Shepherd

@Suite @MainActor struct BatteryPromptTests {
    @Test func promptRequiresBatteryAndLocalWorkAndNeverTimesOut() {
        var policy = BatteryPromptPolicy()
        #expect(!policy.shouldPresent(localRunning: true, phase: .running))
        policy.update(.battery)
        #expect(!policy.shouldPresent(localRunning: false, phase: .running))
        for _ in 0..<100 {
            policy.update(.battery)
            #expect(policy.shouldPresent(localRunning: true, phase: .running))
        }
        #expect(!policy.shouldPresent(localRunning: true, phase: .paused))
        #expect(!policy.shouldPresent(localRunning: true, phase: .pausing))
    }

    @Test func continuingLastsUntilNextBatteryCycle() {
        var policy = BatteryPromptPolicy()
        policy.update(.battery)
        policy.keepRunning()
        policy.update(.unknown)
        policy.update(.battery)
        #expect(!policy.shouldPresent(localRunning: true, phase: .running))
        policy.update(.external)
        #expect(!policy.shouldPresent(localRunning: true, phase: .running))
        policy.update(.battery)
        #expect(policy.shouldPresent(localRunning: true, phase: .running))
    }

    @Test func panelStaysVisibleWithoutTakingKeyboardFocus() {
        let panel = BatteryPromptPanel(model: BatteryPauseModel())
        defer { panel.orderOut(nil) }
        #expect(!panel.styleMask.contains(.closable))
        #expect(panel.styleMask.contains(.nonactivatingPanel))
        #expect(!panel.hidesOnDeactivate)
        #expect(panel.collectionBehavior.contains(.canJoinAllSpaces))
        #expect(panel.collectionBehavior.contains(.fullScreenAuxiliary))
        #expect(panel.level == .statusBar)
        let keyWindow = NSApp.keyWindow
        panel.show()
        #expect(panel.isVisible)
        #expect(NSApp.keyWindow === keyWindow)
        panel.cancelOperation(nil)
        #expect(panel.isVisible)
        if let screen = panel.screen {
            #expect(screen.visibleFrame.contains(panel.frame))
            #expect(abs(panel.frame.maxX - (screen.visibleFrame.maxX - 20)) < 2)
        }
    }
}
