import Foundation
import ShepherdKit

/// One open pull request in Up Next (`UpNextSnapshot.pullRequests`). The server classifies it
/// into a band with one recommended action; clients never recompute that. Until the Swift
/// contract carries the field it is bridged through the snapshot's extra properties, so a server
/// without it yields no PRs at all.
public struct UpNextPr: Codable, Equatable, Sendable, Identifiable {
    public enum Band: String, Codable, Sendable, CaseIterable { case ready, review, blocked, dependabot }
    public enum Action: String, Codable, Sendable, CaseIterable {
        case merge, review, fix
        case dependabotRebase = "dependabot_rebase"
        case approveOnForge = "approve_on_forge"
    }
    public enum BlockReason: String, Codable, Sendable {
        case conflict, behind
        case ciFailed = "ci_failed"
        case workflowApproval = "workflow_approval"
    }
    public enum Kind: String, Codable, Sendable { case regular, dependabot, release }
    public enum Checks: String, Codable, Sendable { case none, pending, success, failure }
    public struct Review: Codable, Equatable, Sendable {
        public var state: String
        public var author: String?
        public init(state: String, author: String? = nil) { self.state = state; self.author = author }
    }
    /// The issue the PR closes; the server may send a bare number or an object.
    public struct ClosesIssue: Codable, Equatable, Sendable {
        public var number: Int
        public var title: String?
        public var url: String?
        public init(number: Int, title: String? = nil, url: String? = nil) {
            self.number = number; self.title = title; self.url = url
        }
        public init(from decoder: any Decoder) throws {
            if let number = try? decoder.singleValueContainer().decode(Int.self) {
                self.init(number: number); return
            }
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.init(number: try container.decode(Int.self, forKey: .number),
                      title: try container.decodeIfPresent(String.self, forKey: .title),
                      url: try container.decodeIfPresent(String.self, forKey: .url))
        }
    }

    public var repoPath: String
    public var repoSlug: String?
    public var repoLabel: String
    public var number: Int
    public var title: String
    public var url: String
    public var author: String?
    public var kind: Kind
    public var createdAt: Int
    public var checks: Checks
    public var mergeable: Bool?
    public var mergeStateStatus: String?
    public var latestReview: Review?
    public var awaitingWorkflowApproval: Bool?
    public var baseRefName: String?
    public var mergeMethod: String?
    public var closesIssue: ClosesIssue?
    public var band: Band
    /// nil: CI is still running, nothing to do yet.
    public var action: Action?
    public var blockReason: BlockReason?
    /// Markdown body when the server includes it; absent from the classification payload.
    public var body: String?

    public var id: String { "\(repoPath)#\(number)" }

    public init(repoPath: String, repoSlug: String? = nil, repoLabel: String, number: Int, title: String, url: String,
                author: String? = nil, kind: Kind = .regular, createdAt: Int, checks: Checks = .success,
                mergeable: Bool? = nil, mergeStateStatus: String? = nil, latestReview: Review? = nil,
                awaitingWorkflowApproval: Bool? = nil, baseRefName: String? = nil, mergeMethod: String? = nil,
                closesIssue: ClosesIssue? = nil, band: Band, action: Action?, blockReason: BlockReason? = nil,
                body: String? = nil) {
        self.repoPath = repoPath; self.repoSlug = repoSlug; self.repoLabel = repoLabel; self.number = number
        self.title = title; self.url = url; self.author = author; self.kind = kind; self.createdAt = createdAt
        self.checks = checks; self.mergeable = mergeable; self.mergeStateStatus = mergeStateStatus
        self.latestReview = latestReview; self.awaitingWorkflowApproval = awaitingWorkflowApproval
        self.baseRefName = baseRefName; self.mergeMethod = mergeMethod; self.closesIssue = closesIssue
        self.band = band; self.action = action; self.blockReason = blockReason; self.body = body
    }

    /// Unknown server values degrade instead of dropping the PR: an unknown action reads as
    /// "nothing to do yet", an unknown block reason as none. Only an unknown band drops it.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        repoPath = try c.decode(String.self, forKey: .repoPath)
        repoSlug = try c.decodeIfPresent(String.self, forKey: .repoSlug)
        repoLabel = try c.decode(String.self, forKey: .repoLabel)
        number = try c.decode(Int.self, forKey: .number)
        title = try c.decode(String.self, forKey: .title)
        url = try c.decode(String.self, forKey: .url)
        author = try c.decodeIfPresent(String.self, forKey: .author)
        kind = Kind(rawValue: try c.decodeIfPresent(String.self, forKey: .kind) ?? "") ?? .regular
        createdAt = try c.decode(Int.self, forKey: .createdAt)
        checks = Checks(rawValue: try c.decodeIfPresent(String.self, forKey: .checks) ?? "") ?? .none
        mergeable = try c.decodeIfPresent(Bool.self, forKey: .mergeable)
        mergeStateStatus = try c.decodeIfPresent(String.self, forKey: .mergeStateStatus)
        latestReview = try c.decodeIfPresent(Review.self, forKey: .latestReview)
        awaitingWorkflowApproval = try c.decodeIfPresent(Bool.self, forKey: .awaitingWorkflowApproval)
        baseRefName = try c.decodeIfPresent(String.self, forKey: .baseRefName)
        mergeMethod = try c.decodeIfPresent(String.self, forKey: .mergeMethod)
        closesIssue = try c.decodeIfPresent(ClosesIssue.self, forKey: .closesIssue)
        band = try c.decode(Band.self, forKey: .band)
        action = Action(rawValue: try c.decodeIfPresent(String.self, forKey: .action) ?? "")
        blockReason = BlockReason(rawValue: try c.decodeIfPresent(String.self, forKey: .blockReason) ?? "")
        body = try c.decodeIfPresent(String.self, forKey: .body)
    }
}

/// Reads the PR block out of a snapshot. Entries that do not decode are skipped one by one.
public enum UpNextPrs {
    private struct Envelope: Decodable {
        struct Lenient: Decodable {
            let pr: UpNextPr?
            init(from decoder: any Decoder) { pr = try? UpNextPr(from: decoder) }
        }
        let pullRequests: [Lenient]?
    }

    public static func parse(_ snapshot: UpNextSnapshot?) -> [UpNextPr] {
        guard let extra = snapshot?.additionalProperties, extra.value["pullRequests"] != nil,
              let data = try? JSONEncoder().encode(extra),
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else { return [] }
        return (envelope.pullRequests ?? []).compactMap(\.pr)
    }
}

public struct UpNextPrGroup: Identifiable, Equatable {
    public let band: UpNextPr.Band
    public let prs: [UpNextPr]
    public var id: String { band.rawValue }
    public var title: String { UpNextPrPresentation.bandTitle(band) }
    public init(band: UpNextPr.Band, prs: [UpNextPr]) { self.band = band; self.prs = prs }
}

/// What a merge train would run: the Dependabot PRs in the repo with the most of them.
public struct UpNextMergeTrainPlan: Equatable {
    public let repoPath: String
    public let repoLabel: String
    public let prs: [UpNextPr]
    public let otherRepoCount: Int
    public init(repoPath: String, repoLabel: String, prs: [UpNextPr], otherRepoCount: Int) {
        self.repoPath = repoPath; self.repoLabel = repoLabel; self.prs = prs; self.otherRepoCount = otherRepoCount
    }
}

public enum UpNextPrPresentation {
    public enum Tone: Equatable { case green, red, amber, muted }
    public struct StatusToken: Equatable {
        public let text: String
        public let tone: Tone
        /// A CI light carries a dot before its text; a block label does not.
        public let dot: Bool
    }

    public static func key(_ pr: UpNextPr) -> String { pr.id }

    public static func bandTitle(_ band: UpNextPr.Band) -> String {
        switch band {
        case .ready: L.t("native_ios_upnext_pr_band_ready")
        case .review: L.t("native_ios_upnext_pr_band_review")
        case .blocked: L.t("native_ios_upnext_pr_band_blocked")
        case .dependabot: L.t("native_ios_upnext_pr_band_dependabot")
        }
    }

    /// Band order is fixed; within a band the operator's sort applies. Recommended keeps the
    /// server's order, which already ranks by urgency.
    public static func groups(_ prs: [UpNextPr], sort: UpNextSort, repos: Set<String> = []) -> [UpNextPrGroup] {
        banded(prs, sort: sort, repos: repos, pr: { $0 }).map { UpNextPrGroup(band: $0.band, prs: $0.items) }
    }

    /// The same banding over rows that carry a PR plus their server, as the merged list needs.
    public static func banded<T>(_ items: [T], sort: UpNextSort, repos: Set<String> = [],
                                 pr: (T) -> UpNextPr) -> [(band: UpNextPr.Band, items: [T])] {
        let visible = items.filter { repos.isEmpty || repos.contains(pr($0).repoPath) }
        return UpNextPr.Band.allCases.compactMap { band in
            let members = sorted(visible.filter { pr($0).band == band }, sort: sort, pr: pr)
            return members.isEmpty ? nil : (band, members)
        }
    }

    public static func sorted(_ prs: [UpNextPr], sort: UpNextSort) -> [UpNextPr] {
        sorted(prs, sort: sort, pr: { $0 })
    }

    public static func sorted<T>(_ items: [T], sort: UpNextSort, pr: (T) -> UpNextPr) -> [T] {
        guard sort != .recommended else { return items }
        return items.enumerated().sorted { left, right in
            let a = pr(left.element), b = pr(right.element)
            switch sort {
            case .newest where a.createdAt != b.createdAt: return a.createdAt > b.createdAt
            case .oldest where a.createdAt != b.createdAt: return a.createdAt < b.createdAt
            case .titleAscending, .titleDescending:
                let comparison = a.title.localizedCompare(b.title)
                if comparison != .orderedSame {
                    return comparison == (sort == .titleAscending ? .orderedAscending : .orderedDescending)
                }
            default: break
            }
            return left.offset < right.offset
        }.map(\.element)
    }

    /// The bottom bar's green counter.
    public static func readyCount(_ prs: [UpNextPr]) -> Int { prs.filter { $0.band == .ready }.count }

    // MARK: Status line

    public static func ciToken(_ pr: UpNextPr) -> StatusToken {
        switch pr.checks {
        case .success: .init(text: L.t("native_ios_upnext_pr_ci_green"), tone: .green, dot: true)
        case .failure: .init(text: L.t("native_ios_upnext_pr_ci_red"), tone: .red, dot: true)
        case .pending: .init(text: L.t("native_ios_upnext_pr_ci_running"), tone: .amber, dot: true)
        case .none: .init(text: L.t("native_ios_upnext_pr_ci_none"), tone: .muted, dot: true)
        }
    }

    /// The card's second line: the block label first (conflicts, behind, approval), then the CI light.
    public static func statusTokens(_ pr: UpNextPr) -> [StatusToken] {
        var tokens: [StatusToken] = []
        switch pr.blockReason {
        case .conflict: tokens.append(.init(text: L.t("native_ios_upnext_pr_status_conflict"), tone: .red, dot: false))
        case .behind: tokens.append(.init(text: L.t("native_ios_upnext_pr_status_behind"), tone: .amber, dot: false))
        case .workflowApproval:
            tokens.append(.init(text: L.t("native_ios_upnext_pr_status_approval"), tone: .amber, dot: false))
        case .ciFailed, nil:
            if pr.awaitingWorkflowApproval == true {
                tokens.append(.init(text: L.t("native_ios_upnext_pr_status_approval"), tone: .amber, dot: false))
            }
        }
        tokens.append(ciToken(pr))
        return tokens
    }

    // MARK: Sheet facts

    public static func mergeability(_ pr: UpNextPr) -> StatusToken {
        switch pr.blockReason {
        case .conflict: return .init(text: L.t("native_ios_upnext_pr_status_conflict"), tone: .red, dot: false)
        case .behind: return .init(text: L.t("native_ios_upnext_pr_status_behind"), tone: .amber, dot: false)
        default: break
        }
        if pr.mergeable == true { return .init(text: L.t("native_ios_upnext_pr_mergeable_yes"), tone: .green, dot: false) }
        if pr.mergeable == false { return .init(text: L.t("native_ios_upnext_pr_status_conflict"), tone: .red, dot: false) }
        return .init(text: L.t("mergeconfirm_value_unknown"), tone: .muted, dot: false)
    }

    public static func reviewLabel(_ pr: UpNextPr) -> String {
        guard let review = pr.latestReview else { return L.t("native_ios_upnext_pr_review_none") }
        // The handle carries its @ here: a catalog string starting a placeholder with @ breaks paraglide's JSDoc.
        let who = "@" + (review.author ?? "?")
        switch review.state {
        case "approved": return L.t("native_ios_upnext_pr_review_approved", who)
        case "changes_requested": return L.t("native_ios_upnext_pr_review_changes", who)
        default: return L.t("native_ios_upnext_pr_review_comment", who)
        }
    }

    /// "main · Squash"; nil when the server sent neither.
    public static func targetLabel(_ pr: UpNextPr) -> String? {
        let parts = [pr.baseRefName, pr.mergeMethod?.capitalized].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// "repo · @author · 2 h ago"
    public static func tagline(_ pr: UpNextPr, now: Date = Date()) -> [String] {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        let created = Date(timeIntervalSince1970: Double(pr.createdAt) / 1_000)
        var parts = [pr.repoLabel]
        if let author = pr.author { parts.append("@\(author)") }
        parts.append(formatter.localizedString(for: min(created, now), relativeTo: now))
        return parts
    }

    /// Where "Closes #n" leads: the server's URL, else the issue next to the PR on its forge.
    public static func closesIssueURL(_ pr: UpNextPr) -> URL? {
        guard let closes = pr.closesIssue else { return nil }
        if let url = closes.url.flatMap(URL.init) { return url }
        guard let range = pr.url.range(of: "/pull/", options: .backwards) else { return nil }
        return URL(string: pr.url[..<range.lowerBound] + "/issues/\(closes.number)")
    }

    // MARK: Actions

    public static func label(_ action: UpNextPr.Action) -> String {
        switch action {
        case .fix: L.t("native_ios_upnext_pr_action_fix")
        case .merge: L.t("native_ios_upnext_pr_action_merge")
        case .review: L.t("native_ios_upnext_pr_action_review")
        case .dependabotRebase: L.t("native_ios_upnext_pr_action_rebase")
        case .approveOnForge: L.t("native_ios_upnext_pr_action_approve")
        }
    }

    /// Every button the sheet offers, the server's recommendation first. Fix, review and merge are
    /// always there; a Dependabot rebase only for Dependabot PRs, approval only when a workflow waits.
    public static func actions(_ pr: UpNextPr) -> [UpNextPr.Action] {
        var offered: [UpNextPr.Action] = [.fix, .review, .merge]
        if pr.kind == .dependabot { offered.append(.dependabotRebase) }
        if pr.awaitingWorkflowApproval == true || pr.blockReason == .workflowApproval { offered.append(.approveOnForge) }
        guard let primary = pr.action, offered.contains(primary) else { return offered }
        return [primary] + offered.filter { $0 != primary }
    }

    public static func isPrimary(_ action: UpNextPr.Action, for pr: UpNextPr) -> Bool { pr.action == action }

    /// Why "Merge" is locked; nil when merging may be offered. The line names what unlocks it.
    public static func mergeLock(_ pr: UpNextPr) -> String? {
        let base = pr.baseRefName ?? "main"
        switch pr.blockReason {
        case .conflict: return L.t("native_ios_upnext_pr_lock_conflict", base)
        case .behind: return L.t("native_ios_upnext_pr_lock_behind", base)
        case .ciFailed: return L.t("native_ios_upnext_pr_lock_ci")
        case .workflowApproval: return L.t("native_ios_upnext_pr_lock_approval")
        case nil: break
        }
        if pr.checks == .failure { return L.t("native_ios_upnext_pr_lock_ci") }
        if pr.checks == .pending || pr.action == nil { return L.t("native_ios_upnext_pr_lock_running") }
        return nil
    }

    // MARK: Session requests

    private static func fixReason(_ pr: UpNextPr, base: String) -> String {
        switch pr.blockReason {
        case .conflict: L.t("native_ios_upnext_pr_fix_reason_conflict", base)
        case .behind: L.t("native_ios_upnext_pr_fix_reason_behind", base)
        case .ciFailed: L.t("native_ios_upnext_pr_fix_reason_ci")
        case .workflowApproval: L.t("native_ios_upnext_pr_fix_reason_approval")
        case nil: pr.checks == .failure ? L.t("native_ios_upnext_pr_fix_reason_ci") : L.t("native_ios_upnext_pr_fix_reason_generic")
        }
    }

    /// A fix session on the PR's base branch; the agent rebases and repairs what blocks it.
    public static func fixRequest(_ pr: UpNextPr, baseBranch: String) -> CreateSessionRequest {
        .init(repoPath: pr.repoPath, baseBranch: baseBranch,
              // Placeholders are numbered by first appearance: number, title, url, reason, base.
              prompt: L.t("native_ios_upnext_pr_fix_prompt", String(pr.number), pr.title, pr.url,
                          fixReason(pr, base: baseBranch), baseBranch),
              planGateEnabled: false)
    }

    /// A review session that reads the PR and posts findings without merging.
    public static func reviewRequest(_ pr: UpNextPr, baseBranch: String) -> CreateSessionRequest {
        .init(repoPath: pr.repoPath, baseBranch: baseBranch,
              prompt: L.t("native_ios_upnext_pr_review_prompt", String(pr.number), pr.title, pr.url),
              planGateEnabled: false)
    }

    // MARK: Dependabot

    /// Dependabot PRs the train may take: unblocked with green CI.
    public static func trainCandidates(_ prs: [UpNextPr]) -> [UpNextPr] {
        prs.filter { $0.band == .dependabot && $0.blockReason == nil && $0.checks == .success }
    }

    /// `merge-train.ts`: one train per repo; the repo with the most candidates wins.
    public static func trainPlan(_ prs: [UpNextPr]) -> UpNextMergeTrainPlan? {
        let candidates = trainCandidates(prs)
        guard let first = candidates.first else { return nil }
        var byRepo: [String: [UpNextPr]] = [:]
        var order: [String] = []
        for pr in candidates {
            if byRepo[pr.repoPath] == nil { order.append(pr.repoPath) }
            byRepo[pr.repoPath, default: []].append(pr)
        }
        let best = order.max { (byRepo[$0]?.count ?? 0) < (byRepo[$1]?.count ?? 0) } ?? first.repoPath
        let members = byRepo[best] ?? []
        return UpNextMergeTrainPlan(repoPath: best, repoLabel: members.first?.repoLabel ?? first.repoLabel,
                                    prs: members, otherRepoCount: candidates.count - members.count)
    }

    /// `mergeTrainCreateInput(handpicked: true)`: the train never plans or steers elsewhere.
    public static func trainRequest(_ plan: UpNextMergeTrainPlan, baseBranch: String) -> CreateSessionRequest {
        let lines = plan.prs.map { "- #\($0.number) \($0.title) — \($0.url)" }.joined(separator: "\n")
        return .init(repoPath: plan.repoPath, baseBranch: baseBranch,
                     prompt: L.t("prspanel_merge_train_prompt", lines),
                     planGateEnabled: false, autopilotEnabled: false, mergeTrainPrs: plan.prs.map(\.number))
    }

    /// The collapsed Dependabot card: "4 updates · all CI green" or "2 of 4 CI green".
    public static func dependabotSummary(_ prs: [UpNextPr]) -> (title: String, ci: StatusToken) {
        let green = prs.filter { $0.checks == .success }.count
        let ci: StatusToken = green == prs.count
            ? .init(text: L.t("native_ios_upnext_pr_ci_all_green"), tone: .green, dot: true)
            : .init(text: L.t("native_ios_upnext_pr_ci_some_green", String(green), String(prs.count)),
                    tone: green == 0 ? .red : .amber, dot: true)
        return (L.t("native_ios_upnext_pr_updates", String(prs.count)), ci)
    }
}
