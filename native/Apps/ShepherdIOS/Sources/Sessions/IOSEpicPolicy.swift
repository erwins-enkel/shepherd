import Foundation
import ShepherdKit
import ShepherdAppCore

/// iOS decisions live outside view bodies so the offered actions and wire patches agree.
enum IOSEpicPolicy {
    enum Action: Equatable { case pause, resume, approve }
    static func actions(_ epic: Epic) -> [Action] {
        switch epic.run.status.rawValue {
        case "running":
            return [.pause] + (epic.run.mode.iosValue == "attended" && epic.children.contains(where: \.isReady) ? [.approve] : [])
        case "paused": return [.resume]
        default: return []
        }
    }
    static func canStart(_ child: EpicChild) -> Bool {
        child.sessionId == nil && ["ready", "blocked"].contains(child.state.rawValue)
    }
    static func parentURL(_ epic: Epic) -> URL? {
        epic.children.lazy.compactMap { issueURL($0.url, kind: "issues", number: epic.parentIssueNumber) }.first
    }
    static func prURL(_ child: EpicChild) -> URL? {
        child.prNumber.flatMap { issueURL(child.url, kind: "pull", number: $0) }
    }
    static func issueURL(_ raw: String, kind: String, number: Int) -> URL? {
        guard number > 0, var url = URLComponents(string: raw),
              ["https", "http"].contains(url.scheme ?? ""), url.host != nil else { return nil }
        var parts = url.path.split(separator: "/").map(String.init)
        guard parts.count >= 4, parts[parts.count - 2] == "issues", Int(parts.last ?? "") != nil else { return nil }
        parts[parts.count - 2] = kind; parts[parts.count - 1] = String(number)
        url.path = "/" + parts.joined(separator: "/"); url.query = nil; url.fragment = nil
        return url.url
    }
    static func issue(_ child: EpicChild) -> Issue {
        .init(number: child.number, title: child.title, body: child.body, url: child.url,
              labels: [], createdAt: 0, assignees: [], blockedBy: child.blockedBy)
    }
}

struct IOSEpicSettings {
    var mode: Components.Schemas.EpicRunPatch.ModePayload
    var provider: AgentProvider
    var model: String
    var effort: String
    var ignoreUsageCeiling: Bool
    init(_ run: Components.Schemas.EpicRun, defaultProvider: AgentProvider = .claude) {
        mode = run.mode.iosValue == "attended" ? .attended : .auto
        provider = run.agentProvider ?? defaultProvider
        model = run.model ?? "default"; effort = run.effort ?? "default"
        ignoreUsageCeiling = run.ignoreUsageCeiling ?? false
    }
    func patch(start: Bool, running: Bool) -> Components.Schemas.EpicRunPatch {
        .init(mode: mode, status: start ? .running : nil, agentProvider: provider,
              model: model, effort: effort, ignoreUsageCeiling: (start || running) && ignoreUsageCeiling)
    }
    mutating func normalize(fableAvailable: Bool) {
        if model != "default", !ComposeRunConfig.providerModels(provider).contains(model)
            || !ComposeRunConfig.available(model, provider: provider, fableAvailable: fableAvailable) { model = "default" }
        if effort != "default", !ComposeRunConfig.providerEfforts(provider, model: model).contains(effort) { effort = "default" }
    }
}

extension Components.Schemas.EpicMode {
    var iosValue: String { value1?.rawValue ?? value2 ?? "" }
}
