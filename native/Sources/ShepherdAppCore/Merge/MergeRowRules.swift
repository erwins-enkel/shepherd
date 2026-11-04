import ShepherdKit

/// `ui/src/lib/components/viewport/pr-action-row.ts`: the merge row's state, lock reason and
/// fact line. The iOS merge card (#3542) renders these; the server stays the merge gate.
public enum MergeRowRules {
    /// Every kind but `ready` locks Merge and names its reason.
    public enum Kind: String, Sendable {
        case merging, draft, conflict, behind, ciFailed, ciRunning, protected, ready
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

    /// The row exists only while the PR is open.
    public static func visible(_ git: GitState?) -> Bool {
        git?.state.known == .open && git?.number != nil
    }

    /// `prRowStatus`: merging wins, then draft/conflict/behind, then CI, then branch protection.
    /// Stricter than the merge gate elsewhere: any failing or pending check locks Merge here.
    public static func kind(_ git: GitState, merging: Bool) -> Kind {
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
        case .ready: nil
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
        }
    }

    /// `prRowFacts`, in reading order: CI · critic · base · conflicts. A fact the host did not
    /// measure is left out rather than guessed. Without a verdict or a running review the
    /// critic fact is left out too: iOS does not know whether the repo runs the critic.
    public static func facts(_ git: GitState, verdict: ReviewVerdict?, reviewing: Bool, base: String) -> [Fact] {
        [ciFact(git), criticFact(verdict, reviewing: reviewing), baseFact(git, base: base), conflictFact(git)]
            .compactMap { $0 }
    }

    /// `checksCleared` (src/checks-gate.ts): CI green, or no CI to wait on.
    public static func checksCleared(_ git: GitState) -> Bool {
        git.checks.known == .success || (git.noCi == true && git.checks.known == ChecksStateKnown.none)
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
        // pr-conflict.ts `isConflicting`: dirty, or mergeable:false on a non-draft.
        if git.mergeStateStatus?.known == .dirty || (git.mergeable == false && git.isDraft != true) {
            return .init(id: .conflicts, tone: .fail, text: L.t("prrow_fact_conflicts"))
        }
        return git.mergeable == true || measuredClean(git)
            ? .init(id: .conflicts, tone: .ok, text: L.t("prrow_fact_no_conflicts")) : nil
    }
}
