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
    var provider: AgentProvider?
    var model: String
    var effort: String
    var ignoreUsageCeiling: Bool
    private let original: Components.Schemas.EpicRun
    init(_ run: Components.Schemas.EpicRun) {
        original = run
        mode = run.mode.iosValue == "attended" ? .attended : .auto
        provider = run.agentProvider
        model = run.model ?? "default"; effort = run.effort ?? "default"
        ignoreUsageCeiling = run.ignoreUsageCeiling ?? false
    }
    func patch(start: Bool, running: Bool) -> Components.Schemas.EpicRunPatch {
        // Generated EpicRunPatch has single optionals and synthesized encodeIfPresent:
        // nil omits a key; it cannot send explicit JSON null to clear an override.
        // Until the generated contract supports nullable patches, omit inherit changes
        // rather than pinning server defaults. Existing overrides can be cleared on web.
        let ceiling = (start || running) && ignoreUsageCeiling
        return .init(mode: mode.rawValue != original.mode.iosValue ? mode : nil,
              status: start ? .running : nil,
              agentProvider: provider != original.agentProvider ? provider : nil,
              model: provider != nil && model != (original.model ?? "default") && model != "default" ? model : nil,
              effort: provider != nil && effort != (original.effort ?? "default") && effort != "default" ? effort : nil,
              ignoreUsageCeiling: ceiling != (original.ignoreUsageCeiling ?? false) ? ceiling : nil)
    }
    mutating func normalize(fableAvailable: Bool, mythosAvailable: Bool) {
        guard let provider else { model = "default"; effort = "default"; return }
        if model != "default", !ComposeRunConfig.providerModels(provider).contains(model)
            || !ComposeRunConfig.available(model, provider: provider, fableAvailable: fableAvailable,
                                           mythosAvailable: mythosAvailable) { model = "default" }
        if effort != "default", !ComposeRunConfig.providerEfforts(provider, model: model).contains(effort) { effort = "default" }
    }
}

extension Components.Schemas.EpicMode {
    var iosValue: String { value1?.rawValue ?? value2 ?? "" }
}
