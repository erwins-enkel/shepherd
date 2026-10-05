import ShepherdKit

public enum MergeConfirmationRules {
    public static func payload(_ git: GitState) -> Components.Schemas.MergeConfirmation {
        .init(headSha: git.headSha, baseRefName: git.baseRefName,
            handoff: git.mergeGate?.handoff.flatMap { .init(rawValue: $0.rawValue) },
            handoffWho: git.mergeGate?.handoffWho, reviewBlockBy: git.mergeGate?.reviewBlockBy)
    }

    /// `prMergeAvailable` from `ui/src/lib/components/pr-badge.ts`: an open, numbered PR on a
    /// forge that can merge it, with no readiness block. A host without a usable
    /// `mergeStateStatus` (Gitea, GitHub's transient `unknown`) leaves CI as the only signal.
    public static func mergeAvailable(_ git: GitState?) -> Bool {
        guard let git, git.kind?.known == .github || git.kind?.known == .gitea,
              git.state.known == .open, git.number != nil,
              HerdClassifier.prReadinessBlock(git) == nil else { return false }
        let hasMergeState = git.mergeStateStatus != nil && git.mergeStateStatus?.known != .unknown
        return hasMergeState || git.checks.known != .failure
    }
}
