import Foundation
import ShepherdKit
public struct MergeReadyPR: Identifiable, Equatable, Sendable {
    public var id: String
    public var number: Int
    public var title: String
    public var url: String
    public var repo: String
}
public enum MergeRules {
    public static func ready(_ sessions: [Session], git: [String: GitState], reviewing: Set<String>) -> [MergeReadyPR] {
        sessions.compactMap { s in
            guard s.readyToMerge, !reviewing.contains(s.id), let g = git[s.id],
                g.state.known == .open, let number = g.number else { return nil }
            return .init(id: s.id, number: number, title: g.title ?? "", url: g.url ?? "", repo: s.repoPath)
        }
    }
    public static func train(_ prs: [MergeReadyPR]) -> (repo: String?, prs: [MergeReadyPR], excluded: Int) {
        var order: [String] = []; var groups: [String: [MergeReadyPR]] = [:]
        for pr in prs {
            if groups[pr.repo] == nil { order.append(pr.repo) }
            groups[pr.repo, default: []].append(pr)
        }
        var best: String?
        for repo in order where groups[repo, default: []].count > groups[best ?? "", default: []].count { best = repo }
        let chosen = groups[best ?? "", default: []]
        return (best, chosen, prs.count - chosen.count)
    }
    public static func request(repo: String, base: String, prs: [MergeReadyPR]) -> CreateSessionRequest {
        let lines = prs.map { pr in
            "- #\(pr.number)" + (pr.title.isEmpty ? "" : " \(pr.title)") + (pr.url.isEmpty ? "" : " — \(pr.url)")
        }.joined(separator: "\n")
        var request = CreateSessionRequest(repoPath: repo, baseBranch: base,
            prompt: L.t("herd_merge_train_prompt", lines))
        request.mergeTrainPrs = prs.map(\.number)
        request.planGateEnabled = false; request.autopilotEnabled = false
        return request
    }
    public static func resolved(_ q: BuildQueue) -> Int {
        q.steps.filter { $0.status.known == .done || $0.status.known == .skipped }.count
    }
    static func drifted(_ q: BuildQueue, planning: Bool, openPR: Bool) -> Bool {
        q.approved && !q.steps.isEmpty && q.steps.allSatisfy { $0.status.known == .pending } && (!planning || openPR)
    }
    public static func canApprove(_ q: BuildQueue, status: String, planning: Bool, reviewBlocked: Bool, ended: Bool) -> Bool {
        !q.approved && !q.steps.isEmpty && !(planning && reviewBlocked) && !ended && status != "archived"
    }
    public static func canStart(_ q: BuildQueue, status: String, planning: Bool, reviewBlocked: Bool, ended: Bool) -> Bool {
        q.approved && !q.steps.isEmpty && q.steps.allSatisfy { $0.status.known == .pending || $0.status.known == .skipped }
        && resolved(q) < q.steps.count && !(planning && reviewBlocked) && !ended
        && ["idle", "blocked", "done"].contains(status)
    }
    public static func owed(_ records: [PostMergeSteps], repos: Set<String>) -> [PostMergeSteps] {
        records.filter { $0.clearedAt == nil && (repos.isEmpty || repos.contains($0.repoPath)) }
    }
}
