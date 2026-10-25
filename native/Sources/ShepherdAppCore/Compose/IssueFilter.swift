import Foundation
import ShepherdKit

/// The operator's server-persisted default issue filter (#3007, `issueFilter` in /api/settings).
/// A plain mirror of `Components.Schemas.IssueFilterSettings`, bridged through JSON so the open
/// enums stay plain Swift enums. Unknown wire values fail open: an unknown scope or forks value
/// reads as `.all`, an unknown repo override is dropped.
public struct IssueFilterSettings: Codable, Equatable, Sendable {
    public enum Scope: String, CaseIterable, Codable, Sendable {
        case all, mineUnassigned = "mine_unassigned", mine
    }
    public enum Forks: String, CaseIterable, Codable, Sendable {
        case all, own, hide
    }
    public enum RepoOverride: String, CaseIterable, Codable, Sendable {
        case all, mineUnassigned = "mine_unassigned", mine, hide
    }

    public var scope: Scope
    public var forks: Forks
    public var hiddenLabels: [String]
    public var hideActive: Bool
    public var hideSubIssues: Bool
    public var hideBlocked: Bool
    /// Realpath repo key → override replacing scope and forks for that repo.
    public var repoOverrides: [String: RepoOverride]

    /// Mirrors `DEFAULT_ISSUE_FILTER` in src/issue-filter.ts.
    public static let defaults = IssueFilterSettings()

    public init(scope: Scope = .mineUnassigned, forks: Forks = .all, hiddenLabels: [String] = [],
                hideActive: Bool = false, hideSubIssues: Bool = true, hideBlocked: Bool = true,
                repoOverrides: [String: RepoOverride] = [:]) {
        self.scope = scope; self.forks = forks; self.hiddenLabels = hiddenLabels
        self.hideActive = hideActive; self.hideSubIssues = hideSubIssues; self.hideBlocked = hideBlocked
        self.repoOverrides = repoOverrides
    }

    private enum CodingKeys: String, CodingKey {
        case scope, forks, hiddenLabels, hideActive, hideSubIssues, hideBlocked, repoOverrides
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let base = Self.defaults
        scope = try c.decodeIfPresent(String.self, forKey: .scope).map { Scope(rawValue: $0) ?? .all } ?? base.scope
        forks = try c.decodeIfPresent(String.self, forKey: .forks).map { Forks(rawValue: $0) ?? .all } ?? base.forks
        hiddenLabels = try c.decodeIfPresent([String].self, forKey: .hiddenLabels) ?? base.hiddenLabels
        hideActive = try c.decodeIfPresent(Bool.self, forKey: .hideActive) ?? base.hideActive
        hideSubIssues = try c.decodeIfPresent(Bool.self, forKey: .hideSubIssues) ?? base.hideSubIssues
        hideBlocked = try c.decodeIfPresent(Bool.self, forKey: .hideBlocked) ?? base.hideBlocked
        repoOverrides = (try c.decodeIfPresent([String: String].self, forKey: .repoOverrides) ?? [:])
            .compactMapValues(RepoOverride.init(rawValue:))
    }

    /// The generated settings value (or any JSON-shaped value) as this mirror.
    public static func bridged(_ value: some Encodable) throws -> Self {
        try JSONDecoder().decode(Self.self, from: JSONEncoder().encode(value))
    }

    /// The fields that differ from `old`, as a PATCH body.
    public func patch(from old: IssueFilterSettings) -> IssueFilterPatch {
        var patch = IssueFilterPatch()
        if scope != old.scope { patch.scope = scope }
        if forks != old.forks { patch.forks = forks }
        if hiddenLabels != old.hiddenLabels { patch.hiddenLabels = hiddenLabels }
        if hideActive != old.hideActive { patch.hideActive = hideActive }
        if hideSubIssues != old.hideSubIssues { patch.hideSubIssues = hideSubIssues }
        if hideBlocked != old.hideBlocked { patch.hideBlocked = hideBlocked }
        if repoOverrides != old.repoOverrides { patch.repoOverrides = repoOverrides }
        return patch
    }

    /// The patch merged onto this value, as the server merges it.
    public func applying(_ patch: IssueFilterPatch) -> Self {
        var next = self
        if let v = patch.scope { next.scope = v }
        if let v = patch.forks { next.forks = v }
        if let v = patch.hiddenLabels { next.hiddenLabels = v }
        if let v = patch.hideActive { next.hideActive = v }
        if let v = patch.hideSubIssues { next.hideSubIssues = v }
        if let v = patch.hideBlocked { next.hideBlocked = v }
        if let v = patch.repoOverrides { next.repoOverrides = v }
        return next
    }

    /// +1 for a narrowed scope, +1 for a fork rule, +1 per hidden label (Up Next's rules).
    public var activeRuleCount: Int {
        (scope != .all ? 1 : 0) + (forks != .all ? 1 : 0) + hiddenLabels.count
    }

    public func isHidden(label: String) -> Bool {
        hiddenLabels.contains { $0.caseInsensitiveCompare(label) == .orderedSame }
    }

    /// The hidden set with `label` toggled (case-insensitive, as the server matches).
    public func toggledLabels(_ label: String) -> [String] {
        isHidden(label: label) ? hiddenLabels.filter { $0.caseInsensitiveCompare(label) != .orderedSame }
            : hiddenLabels + [label]
    }
}

extension IssueFilterSettings.Scope {
    public var label: String {
        switch self {
        case .all: L.t("upnext_filter_scope_all")
        case .mineUnassigned: L.t("upnext_filter_scope_mine_unassigned")
        case .mine: L.t("upnext_filter_scope_mine")
        }
    }
    public var detail: String {
        switch self {
        case .all: L.t("upnext_filter_scope_all_desc")
        case .mineUnassigned: L.t("upnext_filter_scope_mine_unassigned_desc")
        case .mine: L.t("upnext_filter_scope_mine_desc")
        }
    }
}

extension IssueFilterSettings.Forks {
    public var label: String {
        switch self {
        case .all: L.t("upnext_filter_forks_all")
        case .own: L.t("upnext_filter_forks_own")
        case .hide: L.t("upnext_filter_forks_hide")
        }
    }
    public var detail: String {
        switch self {
        case .all: L.t("upnext_filter_forks_all_desc")
        case .own: L.t("upnext_filter_forks_own_desc")
        case .hide: L.t("upnext_filter_forks_hide_desc")
        }
    }
}

extension IssueFilterSettings.RepoOverride {
    public var label: String {
        switch self {
        case .all: L.t("settings_repo_overrides_opt_all")
        case .mineUnassigned: L.t("settings_repo_overrides_opt_mine_unassigned")
        case .mine: L.t("settings_repo_overrides_opt_mine")
        case .hide: L.t("settings_repo_overrides_opt_hide")
        }
    }
}

/// A partial `IssueFilterSettings`; only the set fields are sent.
public struct IssueFilterPatch: Encodable, Equatable, Sendable {
    public var scope: IssueFilterSettings.Scope?
    public var forks: IssueFilterSettings.Forks?
    public var hiddenLabels: [String]?
    public var hideActive: Bool?
    public var hideSubIssues: Bool?
    public var hideBlocked: Bool?
    public var repoOverrides: [String: IssueFilterSettings.RepoOverride]?

    public init(scope: IssueFilterSettings.Scope? = nil, forks: IssueFilterSettings.Forks? = nil,
                hiddenLabels: [String]? = nil, hideActive: Bool? = nil, hideSubIssues: Bool? = nil,
                hideBlocked: Bool? = nil, repoOverrides: [String: IssueFilterSettings.RepoOverride]? = nil) {
        self.scope = scope; self.forks = forks; self.hiddenLabels = hiddenLabels
        self.hideActive = hideActive; self.hideSubIssues = hideSubIssues; self.hideBlocked = hideBlocked
        self.repoOverrides = repoOverrides
    }

    public var isEmpty: Bool { self == IssueFilterPatch() }

    /// The generated PATCH body.
    func generated() throws -> Components.Schemas.IssueFilterSettingsPatch {
        try JSONDecoder().decode(Components.Schemas.IssueFilterSettingsPatch.self,
                                 from: JSONEncoder().encode(self))
    }
}

/// The server-backed default rules plus the picker's view-only author and label selection.
public struct IssueFilterState: Equatable, Sendable {
    public var settings = IssueFilterSettings.defaults
    public var author: String?
    public var labels: Set<String> = []

    public init(settings: IssueFilterSettings = .defaults, author: String? = nil, labels: Set<String> = []) {
        self.settings = settings; self.author = author; self.labels = labels
    }

    public var scope: IssueFilterSettings.Scope {
        get { settings.scope } set { settings.scope = newValue }
    }
    public var forks: IssueFilterSettings.Forks {
        get { settings.forks } set { settings.forks = newValue }
    }
    public var hideActive: Bool {
        get { settings.hideActive } set { settings.hideActive = newValue }
    }
    public var hideSubIssues: Bool {
        get { settings.hideSubIssues } set { settings.hideSubIssues = newValue }
    }
    public var hideBlocked: Bool {
        get { settings.hideBlocked } set { settings.hideBlocked = newValue }
    }

    public func activeCount(hasViewer: Bool) -> Int {
        var count = settings.hiddenLabels.count
        if settings.scope != .all, hasViewer { count += 1 }
        if settings.forks != .all { count += 1 }
        if settings.hideActive { count += 1 }
        if settings.hideSubIssues { count += 1 }
        if settings.hideBlocked { count += 1 }
        if author != nil { count += 1 }
        count += labels.count
        return count
    }
}

/// Mirrors src/issue-filter.ts (the server applies the same rules to Up Next); keep in sync:
///   - mine: viewer known AND (assignee OR author). A nil viewer fails open (scope and
///     `forks: own` hide nothing).
///   - scope: all | mineUnassigned (mine or unassigned) | mine.
///   - forks (repo is a fork): all | own (only mine) | hide (everything).
///   - a repo override replaces scope + forks: all | mineUnassigned | mine (as the scope) | hide.
///   - hiddenLabels: case-insensitive intersection drops the issue.
///   - attributed to the FIRST rule that drops it: repo override (else scope → forks) → labels.
public enum IssueFilter {
    public enum Rule: String, Sendable { case scope, forks, labels, repo }

    /// What the repo contributes to the rules.
    public struct RepoContext: Equatable, Sendable {
        public var isFork: Bool
        public var override: IssueFilterSettings.RepoOverride?
        public init(isFork: Bool = false, override: IssueFilterSettings.RepoOverride? = nil) {
            self.isFork = isFork; self.override = override
        }
    }

    public enum Stage: CaseIterable, Sendable {
        case repo, scope, forks, hiddenLabels, active, subIssues, blocked, author, labels

        public func message(scope: IssueFilterSettings.Scope) -> String {
            switch self {
            case .repo: L.t("issues_filter_all_repo_override")
            case .scope: scope == .mine ? L.t("issues_filter_all_not_mine") : L.t("issues_filter_all_assigned_to_others")
            case .forks: L.t("issues_filter_all_forks")
            case .hiddenLabels: L.t("issues_filter_all_hidden_labels")
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

    public static func isMine(assignees: [String], author: String?, viewer: String?) -> Bool {
        guard let viewer else { return false }
        return assignees.contains(viewer) || author == viewer
    }

    static func scopeHides(assignees: [String], author: String?, viewer: String?,
                           scope: IssueFilterSettings.Scope) -> Bool {
        if scope == .all || viewer == nil || isMine(assignees: assignees, author: author, viewer: viewer) { return false }
        return scope == .mine || !assignees.isEmpty
    }

    static func forksHides(assignees: [String], author: String?, viewer: String?, repo: RepoContext,
                           forks: IssueFilterSettings.Forks) -> Bool {
        if !repo.isFork || forks == .all { return false }
        if forks == .hide { return true }
        return viewer != nil && !isMine(assignees: assignees, author: author, viewer: viewer)
    }

    static func overrideHides(assignees: [String], author: String?, viewer: String?,
                              override: IssueFilterSettings.RepoOverride) -> Bool {
        switch override {
        case .hide: true
        case .all: false
        case .mineUnassigned: scopeHides(assignees: assignees, author: author, viewer: viewer, scope: .mineUnassigned)
        case .mine: scopeHides(assignees: assignees, author: author, viewer: viewer, scope: .mine)
        }
    }

    static func labelsHide(_ labels: [String], hidden: Set<String>) -> Bool {
        !hidden.isEmpty && labels.contains { hidden.contains($0.lowercased()) }
    }

    /// The first rule that hides the subject, or nil when it stays visible.
    public static func hiddenByRule(assignees: [String], author: String?, labels: [String], viewer: String?,
                                    repo: RepoContext, settings: IssueFilterSettings) -> Rule? {
        if let override = repo.override {
            if overrideHides(assignees: assignees, author: author, viewer: viewer, override: override) { return .repo }
        } else {
            if scopeHides(assignees: assignees, author: author, viewer: viewer, scope: settings.scope) { return .scope }
            if forksHides(assignees: assignees, author: author, viewer: viewer, repo: repo, forks: settings.forks) {
                return .forks
            }
        }
        return labelsHide(labels, hidden: Set(settings.hiddenLabels.map { $0.lowercased() })) ? .labels : nil
    }

    /// Each stage sees only the previous stage's survivors. Once empty, preserve its cause.
    static func apply(
        _ issues: [Issue], viewer: String?, epicParents: Set<Int>, subIssues: Set<Int>,
        state: IssueFilterState, repo: RepoContext = .init()
    ) -> (visible: [Issue], emptiedBy: Stage?) {
        var visible = issues
        guard !visible.isEmpty else { return ([], nil) }
        let settings = state.settings
        let hidden = Set(settings.hiddenLabels.map { $0.lowercased() })
        for stage in Stage.allCases {
            visible = visible.filter { issue in
                switch stage {
                case .repo:
                    guard let override = repo.override else { return true }
                    return !overrideHides(assignees: issue.assignees, author: issue.author, viewer: viewer, override: override)
                case .scope:
                    return repo.override != nil
                        || !scopeHides(assignees: issue.assignees, author: issue.author, viewer: viewer, scope: settings.scope)
                case .forks:
                    return repo.override != nil
                        || !forksHides(assignees: issue.assignees, author: issue.author, viewer: viewer, repo: repo,
                                       forks: settings.forks)
                case .hiddenLabels:
                    return !labelsHide(issue.labels, hidden: hidden)
                case .active:
                    return !settings.hideActive || !issue.labels.contains("shepherd:active")
                case .subIssues:
                    return !settings.hideSubIssues || !subIssues.contains(issue.number) || epicParents.contains(issue.number)
                case .blocked:
                    return !settings.hideBlocked || !issue.labels.contains(where: isBlocked)
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
