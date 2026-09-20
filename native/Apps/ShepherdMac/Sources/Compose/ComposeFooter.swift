import ShepherdKit
import SwiftUI

/// One projection for the footer, disabled state, payload guard and submission guard.
enum ComposeReadiness {
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
    struct State {
        let blocker: String?
        let advisories: [String]
        var canSubmit: Bool { blocker == nil }
        var dualCTA: Bool { advisories.contains("hold_likely") }
        var copy: String {
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

    static func holdLikely(limits: UsageLimits?, settings: ShepherdKit.Settings?) -> Bool {
        guard settings?.usageHoldEnabled == true else { return false }
        let threshold = settings?.usageHoldPct ?? 80
        return max(limits?.session5h?.pct ?? 0, limits?.week?.pct ?? 0) >= threshold
    }
}

extension ComposeModel {
    func readiness(submitting: Bool = false, repoResolved: Bool? = nil, holdLikely: Bool = false) -> ComposeReadiness.State {
        ComposeReadiness.derive(.init(
            promptEmpty: prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            issueSeeded: activeIssue != nil, repoResolved: repoResolved ?? !repoPath.isEmpty,
            baseMissing: repoBranches.baseMissing, repairing: repoBranches.repairingBase,
            uploading: attachments.hasOutstandingUploads, submitting: submitting,
            checking: repoBranches.upstreamLoading, diverged: repoBranches.upstream?.diverged ?? false,
            behind: (repoBranches.upstream?.behind ?? 0) > 0, holdLikely: holdLikely, provider: provider))
    }
}

struct ComposeFooter: View {
    let readiness: ComposeReadiness.State
    let repoName: String?
    let branch: RepoBranchModel
    let held: Bool
    let submit: (Bool) -> Void

    private var submitCopy: String {
        if readiness.blocker == "submitting" { return L.t("newtask_spawning") }
        return repoName.map { L.t("newtask_submit_in_repo", $0) } ?? L.t("newtask_submit")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: readiness.copy).font(.caption).foregroundStyle(.secondary)
            if readiness.advisories.contains("checking") {
                Text(verbatim: L.t("newtask_upstream_checking")).font(.caption).foregroundStyle(.secondary)
            } else if readiness.advisories.contains("diverged") {
                Text(verbatim: L.t("newtask_upstream_diverged", String(branch.upstream?.behind ?? 0),
                                  String(branch.upstream?.ahead ?? 0), branch.baseBranch))
                    .font(.caption).foregroundStyle(.secondary)
            } else if readiness.advisories.contains("behind") {
                Text(verbatim: L.t("newtask_upstream_behind", String(branch.upstream?.behind ?? 0)))
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Text(verbatim: held ? L.t("keymap_footer_held", "⌘") : L.t("keymap_footer_idle", "⌘"))
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                Spacer()
                if readiness.dualCTA {
                    Button { submit(false) } label: {
                        Text(verbatim: L.t("newtask_hold_for_reset") + "  " + ComposeKeymap.entry("submit").cap)
                    }
                    .keyboardShortcut(.return, modifiers: .command)
                    .accessibilityIdentifier("compose.hold")
                    Button(L.t("newtask_submit_anyway")) { submit(true) }
                        .accessibilityIdentifier("compose.submitAnyway")
                } else {
                    // The default action exists ONLY for the single CTA. In the pair, ⌘↵ holds.
                    Button { submit(false) } label: {
                        Text(verbatim: submitCopy + "  " + ComposeKeymap.entry("submit").cap)
                    }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("compose.submit")
                }
            }
            .disabled(!readiness.canSubmit)
        }
    }
}
