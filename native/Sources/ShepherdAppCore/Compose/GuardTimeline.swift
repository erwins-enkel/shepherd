import Foundation
import ShepherdKit

/// Message-key projection of the web guard timeline. No view or localization state.
public struct GuardTimeline: Equatable, Sendable {
    public enum Kind: String, Sendable { case human, auto, conditional }
    public struct Step: Identifiable, Equatable, Sendable {
        public let id: String
        public let kind: Kind
        public let key: String
        public let repoScoped: Bool
    }
    public struct Repo: Sendable {
        public var critic: Bool
        public var autoAddress: Bool
        public var autoMerge: Bool
        public var draftMode: Bool
        public init(critic: Bool, autoAddress: Bool, autoMerge: Bool, draftMode: Bool) {
            self.critic = critic; self.autoAddress = autoAddress
            self.autoMerge = autoMerge; self.draftMode = draftMode
        }
        public init(_ config: RepoConfig) {
            self.init(critic: config.criticEnabled, autoAddress: config.autoAddressEnabled,
                      autoMerge: config.autoMergeEnabled, draftMode: config.draftMode)
        }
    }
    public let headerKey: String
    public let steps: [Step]

    public static func derive(planGate: Bool, autopilot: Bool, provider: AgentProvider,
                              baseBranch: String, repo: Repo? = nil) -> Self {
        let suffix = !autopilot ? "manual" : provider == .codex ? "auto_codex" : "auto"
        var steps: [Step] = []
        func add(_ id: String, _ kind: Kind, _ key: String, repoScoped: Bool = false) {
            steps.append(.init(id: id, kind: kind, key: key, repoScoped: repoScoped))
        }
        func driven(_ id: String, _ stem: String) {
            let kind: Kind = !autopilot ? .human : provider == .codex ? .conditional : .auto
            let ending = !autopilot ? "you" : provider == .codex ? "auto_codex" : "auto"
            add(id, kind, "guardtl_step_\(stem)_\(ending)")
        }
        if planGate {
            add("grill", .human, "guardtl_step_grill")
            add("review", .conditional, "guardtl_step_review")
            driven("release", "release")
        }
        driven("to-pr", "topr")
        if let repo {
            add("critic", repo.critic ? .conditional : .human,
                !repo.critic ? "guardtl_step_critic_off" : repo.autoAddress ? "guardtl_step_critic_auto" : "guardtl_step_critic_manual",
                repoScoped: true)
            let reason: String?
            if baseBranch.range(of: #"^epic/\d+(-[a-z0-9-]+)?$"#, options: .regularExpression) != nil { reason = "epic" }
            else if !autopilot { reason = "autopilot" }
            else if repo.draftMode { reason = "draft" }
            else if !repo.autoMerge { reason = "automerge" }
            else { reason = nil }
            add("merge", reason == nil ? .conditional : .human,
                reason.map { "guardtl_step_merge_you_\($0)" }
                    ?? (provider == .codex ? "guardtl_step_merge_train_codex" : "guardtl_step_merge_train"), repoScoped: true)
        }
        return .init(headerKey: "guardtl_head_\(planGate ? "plan" : "nogate")_\(suffix)", steps: steps)
    }
}

extension GuardTimeline {
    public static func copy(_ key: String) -> String {
        switch key {
        case "guardtl_head_plan_manual": L.t("guardtl_head_plan_manual")
        case "guardtl_head_plan_auto": L.t("guardtl_head_plan_auto")
        case "guardtl_head_nogate_manual": L.t("guardtl_head_nogate_manual")
        case "guardtl_head_nogate_auto": L.t("guardtl_head_nogate_auto")
        case "guardtl_step_grill": L.t("guardtl_step_grill")
        case "guardtl_step_review": L.t("guardtl_step_review")
        case "guardtl_step_release_you": L.t("guardtl_step_release_you")
        case "guardtl_step_release_auto": L.t("guardtl_step_release_auto")
        case "guardtl_step_topr_you": L.t("guardtl_step_topr_you")
        case "guardtl_step_topr_auto": L.t("guardtl_step_topr_auto")
        case "guardtl_step_critic_off": L.t("guardtl_step_critic_off")
        case "guardtl_step_critic_manual": L.t("guardtl_step_critic_manual")
        case "guardtl_step_critic_auto": L.t("guardtl_step_critic_auto")
        case "guardtl_step_merge_you_epic": L.t("guardtl_step_merge_you_epic")
        case "guardtl_step_merge_you_autopilot": L.t("guardtl_step_merge_you_autopilot")
        case "guardtl_step_merge_you_draft": L.t("guardtl_step_merge_you_draft")
        case "guardtl_step_merge_you_automerge": L.t("guardtl_step_merge_you_automerge")
        case "guardtl_step_merge_train": L.t("guardtl_step_merge_train")
        case "guardtl_step_merge_train_codex": L.t("guardtl_step_merge_train_codex")
        case "guardtl_divider": L.t("guardtl_divider")
        case "guardtl_marker_you": L.t("guardtl_marker_you")
        case "guardtl_marker_auto": L.t("guardtl_marker_auto")
        case "guardtl_marker_conditional": L.t("guardtl_marker_conditional")
        case "guardtl_open_automation": L.t("guardtl_open_automation")
        case "guardtl_head_plan_auto_codex": L.t("guardtl_head_plan_auto_codex")
        case "guardtl_head_nogate_auto_codex": L.t("guardtl_head_nogate_auto_codex")
        case "guardtl_step_release_auto_codex": L.t("guardtl_step_release_auto_codex")
        case "guardtl_step_topr_auto_codex": L.t("guardtl_step_topr_auto_codex")
        default: ""
        }
    }
}
