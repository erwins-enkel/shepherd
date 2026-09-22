import ShepherdKit
import SwiftUI

/// One projection for the footer, disabled state, payload guard and submission guard.
public enum ComposeReadiness {
    struct Input {
        var promptEmpty: Bool
        var issueSeeded: Bool
        var repoResolved: Bool
        var baseMissing: Bool
        var repairing: Bool
        var uploading: Bool
        var submitting: Bool
        var checking: Bool
        var diverged: Bool
        var behind: Bool
        var holdLikely: Bool
        var provider: AgentProvider
    }
    public struct State {
        public let blocker: String?
        public let advisories: [String]
        public var canSubmit: Bool { blocker == nil }
        public var dualCTA: Bool { advisories.contains("hold_likely") }
        public var copy: String {
            switch blocker {
            case "submitting": L.t("newtask_spawning")
            case "uploading": L.t("newtask_uploading")
            case "repairing": L.t("newtask_readiness_repairing")
            case "no_repo": L.t("newtask_readiness_no_repo")
            case "base_missing": L.t("newtask_readiness_base_missing")
            case "empty_prompt": L.t("newtask_readiness_empty_prompt")
            default: L.t("newtask_readiness_ready")
            }
        }
    }
    static func derive(_ i: Input) -> State {
        let blocker: String? = i.submitting ? "submitting" : i.uploading ? "uploading"
            : i.repairing ? "repairing" : !i.repoResolved ? "no_repo" : i.baseMissing ? "base_missing"
            : i.promptEmpty && !i.issueSeeded ? "empty_prompt" : nil
        var advisories: [String] = i.checking ? ["checking"] : i.diverged ? ["diverged"] : i.behind ? ["behind"] : []
        if i.holdLikely && i.provider == .claude { advisories.append("hold_likely") }
        return State(blocker: blocker, advisories: advisories)
    }

    public static func holdLikely(limits: UsageLimits?, settings: ShepherdKit.Settings?) -> Bool {
        guard settings?.usageHoldEnabled == true else { return false }
        let threshold = settings?.usageHoldPct ?? 80
        return max(limits?.session5h?.pct ?? 0, limits?.week?.pct ?? 0) >= threshold
    }
}

extension ComposeModel {
    public func readiness(submitting: Bool = false, repoResolved: Bool? = nil, holdLikely: Bool = false) -> ComposeReadiness.State {
        ComposeReadiness.derive(.init(
            promptEmpty: prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            issueSeeded: activeIssue != nil, repoResolved: repoResolved ?? !repoPath.isEmpty,
            baseMissing: repoBranches.baseMissing, repairing: repoBranches.repairingBase,
            uploading: attachments.hasOutstandingUploads, submitting: submitting,
            checking: repoBranches.upstreamLoading, diverged: repoBranches.upstream?.diverged ?? false,
            behind: (repoBranches.upstream?.behind ?? 0) > 0, holdLikely: holdLikely, provider: provider))
    }
}
