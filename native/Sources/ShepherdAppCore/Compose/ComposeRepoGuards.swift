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

    /// The profile a nil override inherits; nil until the repo default loads.
    /// Mirrors the server, which downgrades autonomous to standard for research/epic sessions.
    public var inheritedSandboxProfile: Components.Schemas.SandboxProfile? {
        repoSandboxDefault.map { sandboxLocked && $0 == .autonomous ? .standard : $0 }
    }
    /// The profile the spawn will run under; nil while the inherited repo default is unresolved.
    public var effectiveSandboxProfile: Components.Schemas.SandboxProfile? {
        sandboxProfile ?? inheritedSandboxProfile
    }
}
