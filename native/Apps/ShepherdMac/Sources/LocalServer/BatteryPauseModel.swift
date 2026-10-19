import AppKit
import IOKit.ps
import Observation
import ShepherdAppCore
import ShepherdKit

struct BatteryPromptPolicy {
    private(set) var power: MacPowerSource = .unknown
    private(set) var continuedOnBattery = false

    mutating func update(_ power: MacPowerSource) {
        self.power = power
        if power == .external { continuedOnBattery = false }
    }

    mutating func keepRunning() { continuedOnBattery = true }
    mutating func askAgain() { continuedOnBattery = false }
    func shouldPresent(localRunning: Bool, phase: BatteryPausePhase) -> Bool {
        power == .battery && localRunning && !continuedOnBattery && !phase.isActive
    }
}

@Observable @MainActor
final class BatteryPauseModel {
    static let shared = BatteryPauseModel()
    private(set) var phase: BatteryPausePhase = .running
    private(set) var error: String?
    private(set) var policy = BatteryPromptPolicy()
    private var task: Task<Void, Never>?
    private var source: CFRunLoopSource?
    private var panel: BatteryPromptPanel?
    private var requestedAt: Date?
    private var local: LocalServerModel { .shared }
    private var pause: LocalBatteryPause { local.batteryPause }
    var isActive: Bool { phase.isActive }
    var canPause: Bool { policy.power == .battery && local.state.isRunning && !local.busy && !isActive }

    func start() {
        guard task == nil, !LaunchEnvironment.configuration().isIsolated else { return }
        panel = BatteryPromptPanel(model: self)
        source = IOPSNotificationCreateRunLoopSource({ context in
            guard let context else { return }
            let model = Unmanaged<BatteryPauseModel>.fromOpaque(context).takeUnretainedValue()
            Task { @MainActor in model.refresh() }
        }, Unmanaged.passUnretained(self).toOpaque())?.takeRetainedValue()
        if let source { CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes) }
        refresh()
        task = Task { [weak self] in
            while !Task.isCancelled {
                self?.refresh()
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                              object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.panel?.position() }
        }
    }

    func refresh() {
        policy.update(MacPowerSource.read())
        do { try pause.recoverAbandonedPause() }
        catch { self.error = L.t("native_battery_resume_failed") }
        let actual = pause.phase
        if let requestedAt, (actual == .running || actual == .failed), policy.power == .battery,
           Date().timeIntervalSince(requestedAt) < 10 {
            phase = .pausing
        } else {
            if requestedAt != nil && actual == .running && policy.power == .battery { error = L.t("native_battery_pause_failed") }
            if actual == .failed && phase != .failed { error = L.t("native_battery_pause_failed") }
            requestedAt = nil
            phase = actual
        }
        local.setBatteryPauseActive(isActive)
        if policy.shouldPresent(localRunning: local.state.isRunning, phase: phase) {
            panel?.show()
        } else { panel?.orderOut(nil) }
    }

    func keepRunning() {
        policy.keepRunning()
        error = nil
        panel?.orderOut(nil)
    }

    func pauseUntilPower() {
        guard canPause else { return }
        error = nil
        guard let helper = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("ShepherdPowerHelper") else { return }
        do {
            try pause.start(helper: helper)
            requestedAt = Date()
            phase = .pausing
            local.setBatteryPauseActive(true)
            panel?.orderOut(nil)
        } catch { self.error = L.t("native_battery_pause_failed") }
    }

    func resumeNow() {
        do {
            try pause.resume()
            policy.keepRunning()
            error = nil
        } catch { self.error = L.t("native_battery_resume_failed") }
    }

    func showDecision() {
        policy.askAgain()
        refresh()
    }
}
