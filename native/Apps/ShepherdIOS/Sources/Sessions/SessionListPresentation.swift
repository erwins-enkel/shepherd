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
        questionsUnanswered: Bool = false, showCli: Bool = false,
        repoAutopilotDefault: Bool? = nil, now: Int
    ) -> Card {
        var badges = SessionBadges.items(for: session, block: block, git: git,
            verdict: verdict, reviewing: reviewing, showCli: showCli, now: now,
            repoAutopilotDefault: repoAutopilotDefault)
        // Read-only cue: tapping the card always opens the existing detail view.
        if questionsUnanswered || session.autopilotPaused || block?.shape.known == .yesNo {
            badges.append(.init(id: "answer", text: L.t("hold_cta_answer"), tint: .blue))
        }
        let summary = recap?.state.known == .ready ? recap?.headline : activity?.summary
        var metadata = [session.desig]
        // Open Session fields are preserved by the generated schema; never infer priority.
        if let priority = session.additionalProperties.value["priority"] as? String, !priority.isEmpty {
            metadata.append(priority)
        } else if session.additionalProperties.value["priority"] as? Bool == true {
            metadata.append(L.t("upnext_pill_priority"))
        }
        let effort = session.runtimeEffort ?? session.effort
        if let effort, !effort.isEmpty { metadata.append(effortLabel(effort)) }
        return Card(session: session, displayed: displayed, age: elapsed(session.createdAt, now: now),
            summary: summary?.isEmpty == false ? summary : nil, badges: badges,
            progress: HerdStepper(info: HerdClassifier.deriveStage(session: session, git: git,
                verdict: verdict, reviewing: reviewing)), metadata: metadata.joined(separator: " · "))
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
