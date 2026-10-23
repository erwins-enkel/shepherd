import Foundation
import ShepherdKit

/// The machine choice (#2772–#2776) in words, for both apps. The server decides and reports a
/// language-neutral record (`MachinePlacement`) or why it would refuse (`MachineRefusal`); this is
/// the one place those become sentences, so New Task, the herd and a session's detail cannot
/// drift apart. Ported from the web's `ui/src/lib/placement.ts`, `machines.ts`,
/// `components/new-task/run-on.ts` and the placement explanations in `tooltips/explanations.ts`.
///
/// One deliberate difference: the web says "This machine" / "Run here" for the Shepherd it is
/// served from. A native app is not that machine, so every machine is named by its name.
public enum PlacementCopy {
    /// Capabilities a task can name in New Task: the vocabulary except platforms not released for
    /// tasks (Windows). The web's `REQUIREMENT_OPTIONS`.
    public static let requirementOptions: [String] = [
        "platform:linux", "platform:macos", "xcode", "sdk:macos", "sdk:ios", "ios-simulator",
        "android-sdk", "agent:claude", "agent:codex", "sandbox:trusted", "sandbox:standard",
        "sandbox:autonomous",
    ]

    /// A capability's name; one a newer server might add reads as its ID.
    public static func capabilityLabel(_ id: String) -> String {
        switch id {
        case "platform:linux": L.t("settings_machines_platform_linux")
        case "platform:macos": L.t("settings_machines_platform_macos")
        case "platform:windows": L.t("settings_machines_platform_windows")
        case "xcode": L.t("settings_machines_cap_xcode")
        case "sdk:macos": L.t("settings_machines_cap_sdk_macos")
        case "sdk:ios": L.t("settings_machines_cap_sdk_ios")
        case "ios-simulator": L.t("settings_machines_cap_ios_simulator")
        case "android-sdk": L.t("settings_machines_cap_android_sdk")
        case "agent:claude": L.t("settings_machines_cap_agent_claude")
        case "agent:codex": L.t("settings_machines_cap_agent_codex")
        case "sandbox:trusted": L.t("settings_machines_cap_sandbox_trusted")
        case "sandbox:standard": L.t("settings_machines_cap_sandbox_standard")
        case "sandbox:autonomous": L.t("settings_machines_cap_sandbox_autonomous")
        default: id
        }
    }

    /// Why a machine lacks a capability; a code a newer server might add reads as itself.
    public static func reasonLabel(_ reason: String) -> String {
        switch reason {
        case "not_verified": L.t("settings_machines_cap_reason_not_verified")
        case "not_installed": L.t("settings_machines_cap_reason_not_installed")
        case "not_logged_in": L.t("settings_machines_cap_reason_not_logged_in")
        case "timeout": L.t("settings_machines_cap_reason_timeout")
        case "probe_failed": L.t("settings_machines_cap_reason_probe_failed")
        case "not_probed": L.t("settings_machines_cap_reason_not_probed")
        case "sdk_not_found": L.t("settings_machines_cap_reason_sdk_not_found")
        case "sdk_incomplete": L.t("settings_machines_cap_reason_sdk_incomplete")
        case "no_backend": L.t("settings_machines_cap_reason_no_backend")
        case "no_egress": L.t("settings_machines_cap_reason_no_egress")
        case "license_not_accepted": L.t("settings_machines_cap_reason_license_not_accepted")
        case "command_line_tools_only": L.t("settings_machines_cap_reason_command_line_tools_only")
        case "no_simulator": L.t("settings_machines_cap_reason_no_simulator")
        default: reason
        }
    }

    /// A platform's name as Settings → Machines writes it; anything else reads as itself.
    public static func platformLabel(_ platform: String) -> String {
        switch platform {
        case "linux": L.t("settings_machines_platform_linux")
        case "macos": L.t("settings_machines_platform_macos")
        case "windows": L.t("settings_machines_platform_windows")
        default: platform
        }
    }

    /// Why a machine a task waits for is out of reach: its connection status, or "Unreachable"
    /// for the reason codes an unreachable machine reports (timeout, network, …).
    public static func offlineLabel(_ status: String?) -> String {
        switch status {
        case "unauthorized": L.t("settings_machines_status_unauthorized")
        case "incompatible": L.t("settings_machines_status_incompatible")
        case "identity_mismatch": L.t("settings_machines_status_identity_mismatch")
        case "checking": L.t("settings_machines_status_checking")
        default: L.t("settings_machines_status_unreachable")
        }
    }

    /// "macOS and Xcode" / "macOS und Xcode".
    public static func capabilityList(_ ids: [String]) -> String {
        ids.map(capabilityLabel).formatted(.list(type: .and))
    }

    /// "MacBook (macOS)", as Run on lists a machine.
    public static func machineLabel(_ host: SessionHost) -> String {
        L.t("newtask_runon_machine", host.name, RemoteSessionCopy.platformName(host.platform))
    }

    /// Glossary markers (`[[id|Label]]`) the web renders as terms, read as their label.
    public static func plain(_ text: String) -> String {
        text.replacingOccurrences(of: #"\[\[[^|\[\]]+\|([^\[\]]+)\]\]"#, with: "$1", options: .regularExpression)
    }

    // MARK: - Why a task runs where it runs

    /// "Needs macOS and Xcode", "No special requirements – preferred: Linux", "Chosen manually", …
    private static func selectionReason(_ placement: MachinePlacement) -> String {
        let ids = placement.requirements.map(\.rawValue)
        let list = capabilityList(ids)
        let platform = platformLabel(placement.preferred ?? placement.target.platform.rawValue)
        switch placement.basis.rawValue {
        case "load": return L.t("placement_basis_load", placement.load?.preferredHost.name ?? "")
        case "manual": return L.t("placement_basis_manual")
        case "requirements": return L.t("placement_basis_requirements", list)
        case "preference":
            return ids.isEmpty
                ? L.t("placement_basis_preference_none", platform)
                : L.t("placement_basis_preference", list, platform)
        case "only_candidate": return L.t("placement_basis_only")
        default: return ids.isEmpty ? "" : L.t("placement_basis_requirements", list)
        }
    }

    public static func reason(_ placement: MachinePlacement) -> String {
        let reason = selectionReason(placement)
        let note: String
        switch placement.load?.state.rawValue {
        case "busy": note = L.t("placement_load_busy")
        case "unknown": note = L.t("placement_load_unknown")
        default: note = ""
        }
        return note.isEmpty ? reason : "\(reason). \(note)"
    }

    private static func loadObservation(_ machine: String, _ report: Components.Schemas.HostLoadReport?) -> String {
        guard let report, !report.stale else { return L.t("placement_load_unavailable", machine) }
        let ratio = (report.load1 / Double(report.cpuCount)).formatted(.number.precision(.fractionLength(0...2)))
        return L.t("placement_load_detail", machine, ratio, String(report.runningSessions))
    }

    /// "Runs on MacBook — Needs Xcode", before the task is submitted.
    public static func runsOn(_ placement: MachinePlacement) -> String {
        let text = L.t("placement_runs_on", placement.target.name, reason(placement))
        return placement.load == nil || placement.mode.rawValue != "auto" ? text : "\(text). \(L.t("placement_load_recheck"))"
    }

    /// "Waits for MacBook — Needs Xcode. …", and where it could run now instead (#2775).
    public static func waits(_ placement: MachinePlacement, _ wait: PlacementWait) -> String {
        let text = L.t("placement_waits_for", placement.target.name, reason(placement))
        let others = wait.alternatives.map(\.name).joined(separator: ", ")
        return others.isEmpty ? text : "\(text) \(L.t("placement_refusal_alternatives", others))"
    }

    // MARK: - Why a task would not start

    /// What a named machine lacks: "Xcode (not installed)".
    static func missingList(_ missing: [MachineRefusal.Missing]) -> String {
        missing.map { item in
            item.reason.map { "\(capabilityLabel(item.capability)) (\(reasonLabel($0)))" }
                ?? capabilityLabel(item.capability)
        }.joined(separator: ", ")
    }

    /// The preview's warning and the composer's error after a refused create. A code a newer
    /// server might add reads as the server's own sentence.
    public static func refusal(_ refusal: MachineRefusal) -> String {
        let machine = refusal.host?.name ?? ""
        switch refusal.code {
        case "no_suitable_machine":
            let ids = refusal.missing.map(\.capability)
            let list = capabilityList(ids)
            let head = ids.isEmpty ? L.t("placement_refusal_none_any")
                : refusal.together && ids.count > 1 ? L.t("placement_refusal_none_together", list)
                : L.t("placement_refusal_none", list)
            let elsewhere = refusal.elsewhere.map(\.name).joined(separator: ", ")
            return elsewhere.isEmpty ? head : "\(head) \(L.t("placement_refusal_elsewhere", elsewhere))"
        case "missing_capabilities":
            let list = missingList(refusal.missing)
            // Without a host: the server's own fresh check at acceptance refused it.
            return refusal.host == nil
                ? L.t("placement_refusal_missing_here", list)
                : L.t("placement_refusal_missing", machine, list)
        case "remote_target_unavailable": return L.t("placement_refusal_unavailable", machine)
        case "remote_target_unreleased": return L.t("placement_refusal_unreleased", machine)
        case "remote_project_missing": return L.t("placement_refusal_project_missing", machine)
        case "remote_target_unknown": return L.t("placement_refusal_unknown")
        case "remote_project_unknown": return L.t("newtask_runon_project_unknown")
        default: return refusal.error
        }
    }

    /// A send to a machine that went unanswered — it may have started there. Only then does the
    /// next attempt reuse the Idempotency-Key. A transport failure on the way to the server counts
    /// too: the request may have gone through.
    public static func isUnanswered(_ error: any Error) -> Bool {
        switch error as? ShepherdError {
        case .upstreamFailure(code: "remote_dispatch_unknown"?, message: _), .transport: true
        default: false
        }
    }

    /// What the composer says when the machine choice refused the task, or when `machine` (the
    /// machine it was sent to, when known) could not start it. Nil when the failure is not about
    /// the machine: the composer's generic message applies. The web's `placementFailureMessage ??
    /// runOnFailureMessage`.
    public static func failure(_ error: any Error, machine: String?) -> String? {
        if let refusal = error as? MachineRefusal {
            switch refusal.code {
            case "no_suitable_machine", "missing_capabilities": return Self.refusal(refusal)
            default:
                return runOnFailure(code: refusal.code, machine: refusal.host?.name ?? machine,
                                    message: refusal.error) ?? Self.refusal(refusal)
            }
        }
        guard let machine else { return nil }
        if isUnanswered(error) { return L.t("newtask_runon_unknown", machine) }
        switch error as? ShepherdError {
        case .conflict(let code?, let message), .upstreamFailure(let code?, let message):
            return runOnFailure(code: code, machine: machine, message: message)
        default:
            return nil
        }
    }

    private static func runOnFailure(code: String, machine: String?, message: String) -> String? {
        if code == "remote_project_unknown" { return L.t("newtask_runon_project_unknown") }
        guard let machine else { return nil }
        switch code {
        case "remote_rejected": return L.t("newtask_runon_rejected", machine, message)
        case "remote_upload_failed": return L.t("newtask_runon_upload_failed", machine, message)
        case "remote_target_unavailable": return L.t("newtask_runon_unavailable", machine)
        case "remote_target_unreleased": return L.t("newtask_runon_unreleased", machine)
        case "remote_project_missing": return L.t("newtask_runon_project_missing", machine)
        case "remote_target_unknown": return L.t("newtask_runon_gone", machine)
        case "remote_dispatch_unknown": return L.t("newtask_runon_unknown", machine)
        default: return nil
        }
    }

    /// What a create answered with a hold: it waits for its machine (#2775), the machine holds it,
    /// or the usage hold queued it here.
    public static func held(_ task: HeldTask) -> String {
        guard let host = task.host else { return L.t("native_newsession_held") }
        return task.waiting == true ? L.t("toast_task_waiting_for", host.name) : L.t("toast_task_held_on", host.name)
    }

    // MARK: - Explanations

    /// How Run on chooses the machine, where the session starts, what the machine has of the code
    /// and what happens when it cannot start there. The web's `runOnExplanation`.
    public static func runOnExplanation() -> RemoteExplanation {
        RemoteExplanation(
            title: L.t("tooltip_runon_title"), summary: L.t("tooltip_runon_summary"),
            sections: [
                .init(label: L.t("tooltip_runon_auto"), text: L.t("tooltip_runon_auto_body")),
                .init(label: L.t("tooltip_runon_code"), text: L.t("tooltip_runon_code_body")),
                .init(label: L.t("tooltip_runon_attachments"), text: L.t("tooltip_runon_attachments_body")),
                .init(label: L.t("tooltip_runon_failure"), text: L.t("tooltip_runon_failure_body")),
            ])
    }

    /// What was read from the task and that the chips are the operator's to correct.
    public static func derivedExplanation() -> RemoteExplanation {
        RemoteExplanation(
            title: L.t("tooltip_derive_title"), summary: L.t("tooltip_derive_summary"),
            sections: [
                .init(label: L.t("tooltip_derive_reads"), text: L.t("tooltip_derive_reads_body")),
                .init(label: L.t("tooltip_derive_correct"), text: L.t("tooltip_derive_correct_body")),
            ])
    }

    /// Why a task runs where it runs: the reason, what it needed, who decided.
    public static func explanation(_ placement: MachinePlacement) -> RemoteExplanation {
        let ids = placement.requirements.map(\.rawValue)
        var sections: [RemoteExplanation.Section] = [
            .init(label: L.t("tooltip_placement_needs"),
                  text: ids.isEmpty ? L.t("tooltip_placement_needs_none") : capabilityList(ids)),
            .init(label: L.t("tooltip_placement_how"),
                  text: placement.mode.rawValue == "manual"
                    ? L.t("tooltip_placement_how_manual") : L.t("tooltip_placement_how_auto")),
        ]
        if let load = placement.load {
            sections.append(.init(label: L.t("placement_load_observed"),
                text: loadObservation(placement.target.name, load.selectedReport)))
            if load.state.rawValue == "diverted" {
                sections.append(.init(label: L.t("placement_load_preferred"),
                    text: loadObservation(load.preferredHost.name, load.preferredReport)))
            }
        }
        sections.append(.init(label: L.t("tooltip_placement_by"), text: placement.by.name))
        return RemoteExplanation(title: L.t("tooltip_placement_title", placement.target.name),
            summary: reason(placement), sections: sections)
    }

    /// That a task never moves on its own, and where it could run now instead.
    static func noFallback(_ alternatives: [SessionHost]?) -> String {
        let machines = (alternatives ?? []).map(\.name).joined(separator: ", ")
        return machines.isEmpty ? L.t("tooltip_waiting_fallback_none") : L.t("tooltip_waiting_fallback_body", machines)
    }

    /// The machine a task is meant for is out of reach, before it is submitted: it would wait.
    public static func waitExplanation(_ placement: MachinePlacement, _ wait: PlacementWait) -> RemoteExplanation {
        let machine = placement.target.name
        return RemoteExplanation(
            title: L.t("tooltip_waiting_title", machine),
            summary: L.t("tooltip_waiting_offline_summary", machine, reason(placement)),
            sections: [
                .init(label: L.t("tooltip_waiting_connection"), text: offlineLabel(wait.status)),
                .init(label: L.t("tooltip_waiting_start"), text: L.t("tooltip_waiting_start_body", machine)),
                .init(label: L.t("tooltip_waiting_fallback"), text: noFallback(wait.alternatives)),
            ])
    }
}
