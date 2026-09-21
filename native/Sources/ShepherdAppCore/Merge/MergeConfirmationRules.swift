import ShepherdKit

public enum MergeConfirmationRules {
    public static func payload(_ git: GitState) -> Components.Schemas.MergeConfirmation {
        .init(headSha: git.headSha, baseRefName: git.baseRefName,
            handoff: git.mergeGate?.handoff.flatMap { .init(rawValue: $0.rawValue) },
            handoffWho: git.mergeGate?.handoffWho, reviewBlockBy: git.mergeGate?.reviewBlockBy)
    }
}
