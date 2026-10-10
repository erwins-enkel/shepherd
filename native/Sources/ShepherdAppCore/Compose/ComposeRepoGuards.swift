import ShepherdKit

extension ComposeModel {
    /// macOS opts into repo defaults. Untouched flags still submit nil (inherit).
    /// A late config response cannot override an operator choice or re-enable non-Code guards.
    public func applyRepoGuardDefaults(planGate: Bool, autopilot: Bool) {
        guard !modeLocked else { return }
        if !planGateTouched { planGateEnabled = planGate }
        if !autopilotTouched { autopilotEnabled = autopilot }
    }
}
