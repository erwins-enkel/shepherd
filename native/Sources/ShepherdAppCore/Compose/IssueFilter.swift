import Foundation
import ShepherdKit

public struct IssueFilterState: Equatable, Sendable {
    public var hideOthers = true
    public var hideActive = false
    public var hideSubIssues = true
    public var hideBlocked = true
    public var author: String?
    public var labels: Set<String> = []

    public func activeCount(hasViewer: Bool) -> Int {
        var count = 0
        if hideOthers, hasViewer { count += 1 }
        if hideActive { count += 1 }
        if hideSubIssues { count += 1 }
        if hideBlocked { count += 1 }
        if author != nil { count += 1 }
        count += labels.count
        return count
    }
}

public enum IssueFilter {
    public enum Stage: CaseIterable, Sendable {
        case others, active, subIssues, blocked, author, labels

        public var message: String {
            switch self {
            case .others: L.t("issues_filter_all_assigned_to_others")
            case .active: L.t("issues_filter_all_in_progress")
            case .subIssues: L.t("issues_filter_all_sub_issues")
            case .blocked: L.t("issues_filter_all_blocked")
            case .author, .labels: L.t("issues_filter_no_match")
            }
        }
    }

    static func isBlocked(_ label: String) -> Bool {
        label.range(of: #"\bblocked"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Each stage sees only the previous stage's survivors. Once empty, preserve its cause.
    static func apply(
        _ issues: [Issue], viewer: String?, epicParents: Set<Int>, subIssues: Set<Int>,
        state: IssueFilterState
    ) -> (visible: [Issue], emptiedBy: Stage?) {
        var visible = issues
        guard !visible.isEmpty else { return ([], nil) }
        for stage in Stage.allCases {
            visible = visible.filter { issue in
                switch stage {
                case .others:
                    return !state.hideOthers || viewer == nil || issue.assignees.isEmpty
                        || issue.assignees.contains(viewer!)
                case .active:
                    return !state.hideActive || !issue.labels.contains("shepherd:active")
                case .subIssues:
                    return !state.hideSubIssues || !subIssues.contains(issue.number) || epicParents.contains(issue.number)
                case .blocked:
                    return !state.hideBlocked || !issue.labels.contains(where: isBlocked)
                case .author:
                    return state.author == nil || issue.author == state.author
                case .labels:
                    return state.labels.isSubset(of: Set(issue.labels))
                }
            }
            if visible.isEmpty { return ([], stage) }
        }
        return (visible, nil)
    }
}
