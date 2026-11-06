import Foundation
import ShepherdKit

/// `ui/src/lib/components/viewport/pr-action-row.ts` and `pr-next-step.ts`: the merge row's
/// state, lock reason, fact line and next step. The iOS merge card (#3542) renders these; the
/// server stays the merge gate.
public enum MergeRowRules {
    /// Every kind but `ready` locks Merge and names its reason.
    public enum Kind: String, Sendable {
        case merging, draft, conflict, behind, ciFailed, ciRunning, protected, ready, merged
    }

    public enum Tone: String, Sendable { case ok, pending, fail }

    public struct Fact: Equatable, Sendable {
        public enum ID: String, Sendable { case ci, critic, base, conflicts }
        public let id: ID
        public let tone: Tone
        public let text: String
        /// `FACT_GLYPH`: the text carries the meaning, the glyph only reinforces it.
        public var glyph: String {
            switch tone { case .ok: "✓"; case .pending: "◌"; case .fail: "✗" }
        }
    }

    /// The row exists while the PR is open, or merged and the session still stands (#3718:
    /// its one action is Stilllegen).
    public static func visible(_ git: GitState?) -> Bool {
        (git?.state.known == .open || git?.state.known == .merged) && git?.number != nil
    }

    /// `prRowStatus`: merging wins, then draft/conflict/behind, then CI, then branch protection.
    /// Stricter than the merge gate elsewhere: any failing or pending check locks Merge here.
    public static func kind(_ git: GitState, merging: Bool) -> Kind {
        if git.state.known == .merged { return .merged }
        if merging || git.inMergeQueue == true { return .merging }
        let block = HerdClassifier.prReadinessBlock(git)
        switch block {
        case .draft: return .draft
        case .conflict: return .conflict
        case .behind: return .behind
        case .blocked, nil: break
        }
        if git.checks.known == .failure { return .ciFailed }
        if git.checks.known == .pending { return .ciRunning }
        return block == .blocked ? .protected : .ready
    }

    /// `mergeBlockedText`: why Merge is locked, or nil when it is free.
    public static func blockedText(_ kind: Kind) -> String? {
        switch kind {
        case .merging: L.t("gitrail_merge_blocked_busy")
        case .draft: L.t("gitrail_merge_blocked_draft")
        case .conflict: L.t("gitrail_merge_blocked_conflict")
        case .behind: L.t("gitrail_merge_blocked_behind")
        case .ciFailed: L.t("gitrail_merge_blocked_checks")
        case .ciRunning: L.t("gitrail_merge_blocked_pending")
        case .protected: L.t("gitrail_merge_blocked_protected")
        case .ready, .merged: nil
        }
    }

    /// `prRowLabel`. `base` names the branch a `behind` PR trails.
    public static func label(_ kind: Kind, base: String) -> String {
        switch kind {
        case .merging: L.t("prrow_merging")
        case .draft: L.t("prrow_state_draft")
        case .conflict: L.t("prrow_state_conflict")
        case .behind: L.t("prrow_state_behind", base)
        case .ciFailed: L.t("prrow_state_ci_failed")
        case .ciRunning: L.t("prrow_state_ci_running")
        case .protected: L.t("prrow_state_protected")
        case .ready: L.t("gitrail_ready_to_merge")
        case .merged: L.t("prrow_state_merged")
        }
    }

    /// `prRowFacts`, in reading order: CI · critic · base · conflicts. A fact the host did not
    /// measure is left out rather than guessed. Without a verdict or a running review the
    /// critic fact is left out too: iOS does not know whether the repo runs the critic.
    public static func facts(_ git: GitState, verdict: ReviewVerdict?, reviewing: Bool, base: String) -> [Fact] {
        if git.state.known == .merged { return [] }
        return [ciFact(git), criticFact(verdict, reviewing: reviewing), baseFact(git, base: base), conflictFact(git)]
            .compactMap { $0 }
    }

    /// `checksCleared` (src/checks-gate.ts): CI green, or no CI to wait on.
    public static func checksCleared(_ git: GitState) -> Bool {
        git.checks.known == .success || (git.noCi == true && git.checks.known == ChecksStateKnown.none)
    }

    // MARK: Next step (#3718, web #3541)

    /// The one action the card offers in its main slot.
    public enum NextAction: String, Sendable { case merge, fixCI, rebase, decommission }

    /// `button` is live; `locked` keeps the button with a reason; `passive` is a hint instead
    /// of a button (autopilot owns the step).
    public enum NextMode: String, Sendable { case button, locked, passive }

    public struct NextStep: Equatable, Sendable {
        public let action: NextAction
        public let mode: NextMode
        /// Why the step is locked, or the passive hint's text. Nil for a live button.
        public let reason: String?
    }

    /// `prNextStep`. `autopilot` is the session's effective autopilot (it already owns red CI
    /// and rebases); `criticReviewing` holds the CI steer, whose failure the critic's findings
    /// steer may carry (#3426).
    public static func nextStep(_ kind: Kind, autopilot: Bool, criticReviewing: Bool, live: Bool) -> NextStep {
        switch kind {
        case .merged: return .init(action: .decommission, mode: .button, reason: nil)
        case .ciFailed:
            if autopilot { return .init(action: .fixCI, mode: .passive, reason: L.t("prrow_passive_ci")) }
            if criticReviewing { return .init(action: .fixCI, mode: .locked, reason: L.t("prrow_locked_critic")) }
            if !live { return .init(action: .fixCI, mode: .locked, reason: L.t("prrow_locked_not_live")) }
            return .init(action: .fixCI, mode: .button, reason: nil)
        case .behind, .conflict:
            if autopilot { return .init(action: .rebase, mode: .passive, reason: L.t("prrow_passive_rebase")) }
            if !live { return .init(action: .rebase, mode: .locked, reason: L.t("prrow_locked_not_live")) }
            return .init(action: .rebase, mode: .button, reason: nil)
        default: return .init(action: .merge, mode: .button, reason: nil)
        }
    }

    /// `agentLive`: a steerable agent is a non-terminal session whose agent runs. `alive` is the
    /// herd's swept liveness; unknown counts as live, a swept husk or strand does not. Resuming
    /// a dead agent stays on the Resume path; a steer never revives it.
    public static func agentLive(_ session: Session, alive: Bool?) -> Bool {
        guard session.terminal != true, alive != false else { return false }
        switch session.status.known {
        case .running, .idle, .blocked: return true
        default: return false
        }
    }

    /// The text the main-slot steer sends, or nil for actions that send nothing. Typed into the
    /// PTY, so fixed English like the server's CI steers.
    public static func steer(_ action: NextAction, git: GitState, base: String) -> String? {
        switch action {
        case .fixCI: ciFixSteer(git)
        case .rebase: rebaseSteer(base: base, conflict: isConflicting(git))
        case .merge, .decommission: nil
        }
    }

    /// `ciFixSteer`. The native contract carries no per-job data, so the failing checks are
    /// always `failingChecks`' pointer to `gh pr checks`, as on the web without jobs.
    public static func ciFixSteer(_ git: GitState) -> String {
        let pr = git.number.map { " \($0)" } ?? ""
        let head = "PR #\(git.number.map(String.init) ?? "?") (head \(String((git.headSha ?? "").prefix(7))))"
        return "Shepherd: CI is failing on \(head): run `gh pr checks\(pr)` once for the failing checks. Read the logs with "
            + "`gh run view <run-id> --log-failed`, fix the root cause, rebase onto your PR's base and push. "
            + "Don't watch the new run — Shepherd steers you when it finishes."
    }

    /// `rebaseSteer`; a conflict also names the resolution.
    public static func rebaseSteer(base: String, conflict: Bool) -> String {
        "Shepherd: your PR is \(conflict ? "in conflict with" : "behind") \(base). Fetch origin and "
            + "rebase your branch onto origin/\(base) (never merge it in)"
            + "\(conflict ? ", resolve the conflicts" : "") and push with --force-with-lease."
    }

    /// `logsHref` without per-job data: the PR's checks tab.
    public static func logsURL(_ git: GitState) -> URL? {
        guard let raw = git.url, let url = URL(string: raw), url.scheme == "https" || url.scheme == "http" else { return nil }
        var path = url.absoluteString
        while path.hasSuffix("/") { path.removeLast() }
        return URL(string: path + "/checks")
    }

    /// pr-conflict.ts `isConflicting`: dirty, or mergeable:false on a non-draft.
    private static func isConflicting(_ git: GitState) -> Bool {
        git.mergeStateStatus?.known == .dirty || (git.mergeable == false && git.isDraft != true)
    }

    private static func measuredClean(_ git: GitState) -> Bool {
        switch git.mergeStateStatus?.known {
        case .clean, .unstable, .hasHooks: true
        default: false
        }
    }

    private static func ciFact(_ git: GitState) -> Fact {
        switch git.checks.known {
        case .success: .init(id: .ci, tone: .ok, text: L.t("prrow_fact_ci_passing"))
        case .failure: .init(id: .ci, tone: .fail, text: L.t("prrow_fact_ci_failed"))
        case .pending: .init(id: .ci, tone: .pending, text: L.t("prrow_fact_ci_running"))
        default: .init(id: .ci, tone: .pending, text: L.t("prrow_fact_ci_none"))
        }
    }

    private static func criticFact(_ verdict: ReviewVerdict?, reviewing: Bool) -> Fact? {
        if reviewing { return .init(id: .critic, tone: .pending, text: L.t("prrow_fact_critic_reviewing")) }
        guard let verdict else { return nil }
        switch verdict.decision.known {
        case .commented: return .init(id: .critic, tone: .ok, text: L.t("prrow_fact_critic_reviewed"))
        case .changesRequested: return .init(id: .critic, tone: .fail, text: L.t("prrow_fact_critic_changes"))
        default: return .init(id: .critic, tone: .fail, text: L.t("prrow_fact_critic_error"))
        }
    }

    private static func baseFact(_ git: GitState, base: String) -> Fact? {
        if git.mergeStateStatus?.known == .behind {
            return .init(id: .base, tone: .fail, text: L.t("prrow_fact_base_behind", base))
        }
        return measuredClean(git) ? .init(id: .base, tone: .ok, text: L.t("prrow_fact_base_current", base)) : nil
    }

    private static func conflictFact(_ git: GitState) -> Fact? {
        if isConflicting(git) {
            return .init(id: .conflicts, tone: .fail, text: L.t("prrow_fact_conflicts"))
        }
        return git.mergeable == true || measuredClean(git)
            ? .init(id: .conflicts, tone: .ok, text: L.t("prrow_fact_no_conflicts")) : nil
    }
}
