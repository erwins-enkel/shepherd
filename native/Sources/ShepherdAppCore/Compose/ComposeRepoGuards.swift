import ShepherdKit

extension ComposeModel {
    /// macOS opts into repo defaults. Untouched flags still submit nil (inherit).
    /// Cache even in Plain: automatic /design preselection can return to Code later.
    public func applyRepoGuardDefaults(planGate: Bool, autopilot: Bool) {
        repoGuardDefaults = (planGate, autopilot)
        reapplyRepoGuardDefaults()
    }

    func reapplyRepoGuardDefaults() {
        guard !modeLocked, let defaults = repoGuardDefaults else { return }
        if !planGateTouched { planGateEnabled = defaults.planGate }
        if !autopilotTouched { autopilotEnabled = defaults.autopilot }
    }

    /// nil means the effective inherited value is unresolved, not disabled.
    public var effectivePlanGate: Bool? {
        planGateTouched ? planGateEnabled : repoGuardDefaults?.planGate
    }
    public var effectiveAutopilot: Bool? {
        autopilotTouched ? autopilotEnabled : repoGuardDefaults?.autopilot
    }
}
