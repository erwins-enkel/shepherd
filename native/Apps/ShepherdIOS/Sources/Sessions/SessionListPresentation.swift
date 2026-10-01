import Foundation
import ShepherdAppCore
import ShepherdKit

/// iOS display mapping only. Partition, filtering, PR badges and progress stay in core.
@MainActor
enum IOSSessionListPresentation {
    struct Card: Identifiable {
        let session: Session
        let displayed: Session
        let age: String
        let summary: String?
        let badges: [SessionBadge]
        let progress: HerdStepper
        let metadata: String
        let heartbeat: [HerdHeartbeat.Cell]
        let opensPlan: Bool
        var id: String { session.id }
    }

    static func groups(_ sidebar: SidebarModel) -> [HerdGroup] { sidebar.groups }

    static func finished(_ sessions: [Session], repos: Set<String>) -> [Session] {
        DonePresentation.filtered(sessions, repos: repos)
    }

    static func outstanding(_ records: [PostMergeSteps], repos: Set<String>) -> [PostMergeSteps] {
        MergeRules.owed(records, repos: repos)
    }

    static func card(
        _ session: Session, displayed: Session, git: GitState? = nil,
        verdict: ReviewVerdict? = nil, reviewing: Bool = false,
        block: BlockReason? = nil, recap: Recap? = nil, activity: SessionActivitySignal? = nil,
        questionsUnanswered: Bool = false,
        planGate: PlanGate? = nil, planReviewing: Bool = false,
        showCli: Bool = false,
        repoAutopilotDefault: Bool? = nil, now: Int
    ) -> Card {
        var badges = SessionBadges.items(for: session, block: block, git: git,
            verdict: verdict, reviewing: reviewing, showCli: showCli, now: now,
            repoAutopilotDefault: repoAutopilotDefault)
        let planChip = PlanGateChip.chip(session: session, gate: planGate, reviewing: planReviewing, allowView: false)
        if let label = planChip.iosLabel {
            badges.append(.init(id: "plan", text: label, tint: planChip.iosBadgeTint))
        }
        if (questionsUnanswered && session.planPhase?.known == .planning) || session.autopilotPaused || block?.shape.known == .yesNo {
            badges.append(.init(id: "answer", text: L.t("hold_cta_answer"), tint: .blue))
        }
        let summary = recap?.state.known == .ready ? recap?.headline : activity?.summary
        var metadata = [session.desig]
        if let model = activity?.runtimeModel ?? session.runtimeModel ?? session.model, !model.isEmpty {
            metadata.append(modelLabel(model))
        }
        // Open Session fields are preserved by the generated schema; never infer priority.
        if let priority = session.additionalProperties.value["priority"] as? String, !priority.isEmpty {
            metadata.append(priority)
        } else if session.additionalProperties.value["priority"] as? Bool == true {
            metadata.append(L.t("upnext_pill_priority"))
        }
        let effort = activity?.runtimeEffort ?? session.runtimeEffort ?? session.effort
        if let effort, !effort.isEmpty { metadata.append(effortLabel(effort)) }
        return Card(session: session, displayed: displayed, age: elapsed(session.createdAt, now: now),
            summary: summary?.isEmpty == false ? summary : nil, badges: badges,
            progress: HerdStepper(info: HerdClassifier.deriveStage(session: session, git: git,
                verdict: verdict, reviewing: reviewing)), metadata: metadata.joined(separator: " · "),
            heartbeat: displayed.status.known == .running ? HerdHeartbeat.cells(activity, now: now) : [],
            opensPlan: IOSPlanPresentation.opensPlan(session: session, gate: planGate, questionsUnanswered: questionsUnanswered))
    }

    /// Concrete runtime model IDs follow the web's runtimeModelLabel notation.
    /// Floating aliases stay verbatim: their historical version is unknown.
    private static func modelLabel(_ model: String) -> String {
        let pattern = #"^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-\d{8})?$"#
        if let regex = try? NSRegularExpression(pattern: pattern),
           let match = regex.firstMatch(in: model, range: NSRange(model.startIndex..., in: model)),
           let family = Range(match.range(at: 1), in: model),
           let major = Range(match.range(at: 2), in: model) {
            let minor = Range(match.range(at: 3), in: model).map { "." + model[$0] } ?? ""
            return "\(model[family].capitalized) \(model[major])\(minor)"
        }
        return model
    }

    static func groupHelp(_ stage: HerdStage) -> String? {
        let key: StaticString
        switch stage {
        case .active: key = "herd_help_active"
        case .ciRunning: key = "herd_help_ci_running"
        case .ciFailed: key = "herd_help_ci_failed"
        case .reviewerRunning: key = "herd_help_reviewing"
        case .reworkRunning: key = "herd_help_rework"
        case .waitingOnReviewer: key = "herd_help_waiting_reviewer"
        case .waitingOnMerger: key = "herd_help_waiting_merger"
        case .draftAwaitingSignoff: key = "herd_help_draft_signoff"
        case .awaitingMerge: key = "herd_help_your_turn"
        case .ready: key = "herd_help_ready"
        case .merging: key = "herd_help_merging"
        case .merged: key = "herd_help_merged"
        // The web's groupHelp map also has no explainer for these stages.
        case .needsRework, .branchProtectionBlocked: return nil
        }
        return L.t(key)
    }

    /// Same units and thresholds as web format.ts. Unit letters are telemetry notation.
    static func elapsed(_ createdAt: Int, now: Int) -> String {
        let seconds = max(0, (now - createdAt) / 1_000)
        let minutes = seconds / 60
        if minutes < 60 { return String(format: "%02d:%02d", minutes, seconds % 60) }
        let hours = minutes / 60
        if hours < 24 { return String(format: "%dh %02dm", hours, minutes % 60) }
        return String(format: "%dd %02dh", hours / 24, hours % 24)
    }

    private static func effortLabel(_ effort: String) -> String {
        switch effort {
        case "low": L.t("effort_label_low")
        case "medium": L.t("effort_label_medium")
        case "high": L.t("effort_label_high")
        case "xhigh": L.t("effort_label_xhigh")
        case "max": L.t("effort_label_max")
        default: effort
        }
    }
}
