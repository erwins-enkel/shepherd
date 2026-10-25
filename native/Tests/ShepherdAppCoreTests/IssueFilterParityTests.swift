import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

private let me = "me"

extension CoreSeamTests {
/// The table from test/issue-filter.test.ts: the Swift predicate must hide exactly what the server hides.
@Suite struct IssueFilterParityTests {
    private struct Subject { var assignees: [String] = []; var author: String?; var labels: [String] = [] }
    private let subjects: [Subject] = [
        Subject(assignees: [me, "x"]),                // mine, assigned
        Subject(assignees: ["x"], author: me),        // mine, authored
        Subject(),                                    // unassigned
        Subject(assignees: ["x"], author: "y"),       // others
    ]

    private func rule(_ s: Subject, viewer: String? = me, _ repo: IssueFilter.RepoContext = .init(),
                      _ settings: IssueFilterSettings = .defaults) -> String {
        IssueFilter.hiddenByRule(assignees: s.assignees, author: s.author, labels: s.labels, viewer: viewer,
                                 repo: repo, settings: settings)?.rawValue ?? "-"
    }

    @Test func isMineIsAssigneeOrAuthorNeverWithANilViewer() {
        #expect(IssueFilter.isMine(assignees: [me, "x"], author: nil, viewer: me))
        #expect(IssueFilter.isMine(assignees: ["x"], author: me, viewer: me))
        #expect(!IssueFilter.isMine(assignees: [], author: nil, viewer: me))
        #expect(!IssueFilter.isMine(assignees: ["x"], author: "y", viewer: me))
        #expect(!IssueFilter.isMine(assignees: ["x"], author: me, viewer: nil))
    }

    @Test func scopeTimesForks() {
        let table: [(IssueFilterSettings.Scope, IssueFilterSettings.Forks, Bool, [String])] = [
            (.all, .all, false, ["-", "-", "-", "-"]),
            (.mineUnassigned, .all, false, ["-", "-", "-", "scope"]),
            (.mine, .all, false, ["-", "-", "scope", "scope"]),
            (.all, .own, false, ["-", "-", "-", "-"]),
            (.all, .own, true, ["-", "-", "forks", "forks"]),
            (.all, .hide, true, ["forks", "forks", "forks", "forks"]),
            (.all, .hide, false, ["-", "-", "-", "-"]),
            (.mineUnassigned, .own, true, ["-", "-", "forks", "scope"]),
            (.mine, .hide, true, ["forks", "forks", "scope", "scope"]),
        ]
        for (scope, forks, isFork, expected) in table {
            let settings = IssueFilterSettings(scope: scope, forks: forks)
            #expect(subjects.map { rule($0, .init(isFork: isFork), settings) } == expected,
                    "\(scope)/\(forks)/\(isFork)")
        }
    }

    @Test func nilViewerFailsOpen() {
        let others = subjects[3]
        for scope in IssueFilterSettings.Scope.allCases {
            #expect(rule(others, viewer: nil, .init(isFork: true), .init(scope: scope, forks: .own)) == "-")
        }
        #expect(rule(others, viewer: nil, .init(isFork: true), .init(forks: .hide)) == "forks")
    }

    @Test func hiddenLabelsAreCaseInsensitiveAndAttributedLast() {
        let designed = Subject(labels: ["Needs-Design"])
        #expect(rule(designed, .init(), .init(hiddenLabels: ["needs-design"])) == "labels")
        #expect(rule(designed, .init(), .init(hiddenLabels: ["other"])) == "-")
        let s = Subject(assignees: ["x"], labels: ["l"])
        let all = IssueFilterSettings(scope: .mine, forks: .hide, hiddenLabels: ["l"])
        #expect(rule(s, .init(isFork: true), all) == "scope")
        var unscoped = all; unscoped.scope = .all
        #expect(rule(s, .init(isFork: true), unscoped) == "forks")
        #expect(rule(s, .init(isFork: false), unscoped) == "labels")
    }

    @Test func repoOverrides() {
        let (mineAssigned, mineAuthored, unassigned, others) = (subjects[0], subjects[1], subjects[2], subjects[3])
        for s in [mineAssigned, unassigned, others] {
            #expect(rule(s, .init(override: .hide), .init(scope: .all)) == "repo")
        }
        let own = IssueFilterSettings(scope: .mine, forks: .own)
        #expect(rule(others, .init(isFork: true), own) == "scope")
        #expect(rule(others, .init(isFork: true, override: .all), own) == "-")
        let hidden = IssueFilterSettings(scope: .all, forks: .hide)
        #expect(rule(mineAuthored, .init(isFork: true, override: .mine), hidden) == "-")
        #expect(rule(unassigned, .init(isFork: true, override: .mine), hidden) == "repo")
        #expect(rule(unassigned, .init(isFork: true, override: .mineUnassigned), hidden) == "-")
        #expect(rule(others, .init(isFork: true, override: .mineUnassigned), hidden) == "repo")
        #expect(rule(others, viewer: nil, .init(override: .mine)) == "-")
        #expect(rule(Subject(labels: ["WIP"]), .init(override: .all), .init(hiddenLabels: ["wip"])) == "labels")
    }

    @Test func applyAttributesTheDefaultRulesInServerOrder() {
        func issue(_ s: Subject) -> ShepherdKit.Issue {
            ShepherdKit.Issue(number: 1, title: "T", body: "", url: "https://example.test/i/1", labels: s.labels,
                              createdAt: 0, assignees: s.assignees, author: s.author)
        }
        let others = issue(Subject(assignees: ["x"], author: "y", labels: ["l"]))
        let unrestricted = IssueFilterState(settings: .init(hideSubIssues: false, hideBlocked: false))
        func emptied(_ settings: IssueFilterSettings, _ repo: IssueFilter.RepoContext = .init()) -> IssueFilter.Stage? {
            IssueFilter.apply([others], viewer: me, epicParents: [], subIssues: [],
                              state: .init(settings: settings), repo: repo).emptiedBy
        }
        #expect(emptied(unrestricted.settings) == .scope)
        #expect(emptied(.init(scope: .all, forks: .hide), .init(isFork: true)) == .forks)
        #expect(emptied(.init(scope: .all, hiddenLabels: ["L"])) == .hiddenLabels)
        #expect(emptied(.init(scope: .all, forks: .hide), .init(isFork: true, override: .mine)) == .repo)
        #expect(emptied(.init(scope: .mine), .init(override: .all)) == nil)
    }
}
}
