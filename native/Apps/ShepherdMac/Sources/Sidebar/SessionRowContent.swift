import Foundation
import ShepherdAppCore
import ShepherdKit

/// The card's copy, derived from the same snapshots as its badges without another request.
struct SessionRowContent {
    let repository: String
    let model: String
    let effort: String?
    let modelNote: String
    let effortNote: String?
    let note: String?
    let coldResume: String?
    let coldResumeNote: String?

    var environment: String { [model, effort].compactMap { $0 }.joined(separator: " · ") }

    init(session: Session, activity: SessionActivitySignal? = nil, hold: HoldReason? = nil,
         gate: PlanGate? = nil, planReviewing: Bool = false, recap: Recap? = nil, now: Int) {
        repository = session.repoPath.split(separator: "/").last.map(String.init) ?? session.repoPath
        let observedModel = [activity?.runtimeModel, session.runtimeModel].compactMap { $0 }.first { !$0.isEmpty }
        let observedEffort = [activity?.runtimeEffort, session.runtimeEffort].compactMap { $0 }.first { !$0.isEmpty }
        let configuredModel = session.model.flatMap { $0.isEmpty ? nil : $0 }
        let configuredEffort = session.effort.flatMap { $0.isEmpty ? nil : $0 }
        model = observedModel.map(Self.runtimeModelLabel)
            ?? configuredModel.map(Self.modelLabel) ?? L.t("newtask_model_default")
        effort = (observedEffort ?? configuredEffort).map(Self.effortLabel)
        modelNote = observedModel != nil
            ? L.t("session_env_model_observed", model) : L.t("session_env_model_configured", model)
        effortNote = effort.map { observedEffort != nil
            ? L.t("session_env_effort_observed", $0) : L.t("session_env_effort_configured", $0) }
        note = Self.planNote(session: session, gate: gate, reviewing: planReviewing, hold: hold)
            ?? (recap?.state.known == .ready ? recap?.headline : activity?.summary)
        let fields = session.additionalProperties.value
        let expires = Self.number(fields["coldResumeAt"])
        let units = Self.number(fields["resumeCostUnits"])
        if session.status.known != .running, session.status.known != .archived,
           let expires, let units, Double(now) > expires, units >= 0.5 {
            let cost = units.formatted(.number.precision(.fractionLength(1)))
            coldResume = L.t("coldresume_chip", cost)
            let context = (session.contextTokens ?? 0).formatted(.number.notation(.compactName))
            coldResumeNote = L.t("coldresume_title", context, cost)
        } else {
            coldResume = nil
            coldResumeNote = nil
        }
    }

    static func elapsed(_ createdAt: Int, now: Int) -> String {
        let seconds = max(0, (now - createdAt) / 1_000)
        let minutes = seconds / 60
        if minutes < 60 { return String(format: "%02d:%02d", minutes, seconds % 60) }
        let hours = minutes / 60
        if hours < 24 { return String(format: "%dh %02dm", hours, minutes % 60) }
        return String(format: "%dd %02dh", hours / 24, hours % 24)
    }

    private static func number(_ value: (any Sendable)?) -> Double? {
        if let value = value as? Int { return Double(value) }
        return value as? Double
    }

    private static func modelLabel(_ model: String) -> String {
        switch model {
        case "claude-fable-5-1": L.t("model_label_fable_5_1")
        case "opus[1m]": L.t("model_label_opus_1m")
        case "sonnet[1m]": L.t("model_label_sonnet_1m")
        case "claude-sonnet-5-5": L.t("model_label_sonnet_5_5")
        case "claude-sonnet-5-5[1m]": L.t("model_label_sonnet_5_5_1m")
        case "claude-opus-5-5": L.t("model_label_opus_5_5")
        case "claude-opus-5-5[1m]": L.t("model_label_opus_5_5_1m")
        case "claude-opus-5": L.t("model_label_opus_5")
        case "claude-opus-5[1m]": L.t("model_label_opus_5_1m")
        default: model
        }
    }

    private static func runtimeModelLabel(_ model: String) -> String {
        let concrete = model.replacingOccurrences(of: #"-\d{8}$"#, with: "", options: .regularExpression)
        if concrete.range(of: #"^claude-(fable|opus|sonnet|haiku)-\d+(?:-\d+)?$"#,
                          options: .regularExpression) != nil {
            let parts = concrete.split(separator: "-")
            return parts[1].capitalized + " " + parts.dropFirst(2).joined(separator: ".")
        }
        if model.range(of: #"^gpt-\d+(?:\.\d+)?(?:-.+)?$"#, options: .regularExpression) != nil {
            let parts = model.split(separator: "-", maxSplits: 2)
            return "GPT-" + parts[1] + (parts.count == 3 ? " " + parts[2].replacingOccurrences(of: "-", with: " ").capitalized : "")
        }
        return modelLabel(model)
    }

    private static func effortLabel(_ effort: String) -> String {
        switch effort {
        case "low": L.t("effort_label_low")
        case "medium": L.t("effort_label_medium")
        case "high": L.t("effort_label_high")
        case "xhigh": L.t("effort_label_xhigh")
        case "max": L.t("effort_label_max")
        case "ultra": L.t("effort_label_ultra")
        default: effort
        }
    }

    private static func planNote(session: Session, gate: PlanGate?, reviewing: Bool, hold: HoldReason?) -> String? {
        guard session.planPhase?.known == .planning, session.status.known != .blocked,
              session.haltReason == nil, !(session.autopilotPaused && session.autopilotQuestion != nil),
              hold.map({ ["plan-rework", "quota-plan", "plan-question"].contains($0.code.rawValue) }) ?? true,
              gate?.dismissed != true else { return hold.map(holdLine) }
        switch PlanGateChip.chip(session: session, gate: gate, reviewing: reviewing, allowView: false) {
        case .reviewing:
            let count = gate?.findings.count ?? 0
            return count > 0 ? L.t("hold_reviewing_findings", String(count)) : L.t("hold_reviewing_plain")
        case .changes(let round, let cap):
            if session.status.known == .running {
                return round > 0 ? L.t("hold_revising_round", String(round), String(cap)) : L.t("hold_revising")
            }
            if round >= cap { return L.t("hold_quota_plan") }
            if PlanGateChip.questionsUnanswered(gate) { return L.t("hold_plan_question") }
            return L.t("hold_awaiting_rereview", String(round), String(cap))
        case .error: return L.t("hold_error")
        case .ready:
            if [.idle, .done].contains(session.status.known) {
                return PlanGateChip.questionsUnanswered(gate) ? L.t("hold_plan_question") : L.t("hold_ready")
            }
        default:
            if [.idle, .done].contains(session.status.known), PlanGateChip.questionsUnanswered(gate) {
                return L.t("hold_plan_question")
            }
        }
        return hold.map(holdLine)
    }

    private static func holdLine(_ hold: HoldReason) -> String {
        let params = hold.params
        switch hold.code.known {
        case .haltedError: return L.t("hold_halted_error")
        case .haltedUsage:
            if let reset = params?.resetAt {
                return L.t("hold_halted_usage", Date(timeIntervalSince1970: Double(reset) / 1_000)
                    .formatted(date: .omitted, time: .shortened))
            }
            return L.t("hold_halted_usage_pending")
        case .autopilotPaused:
            let question = params?.question?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let question, !question.isEmpty { return question }
            return L.t("hold_autopilot_paused")
        case .blockedMenu: return L.t("hold_blocked_menu")
        case .blockedYesNo: return L.t("hold_blocked_yes_no")
        case .blockedAwaitingInput: return L.t("hold_blocked_awaiting_input")
        case .blockedStall: return L.t("hold_blocked_stall")
        case .blockedGeneric: return L.t("hold_blocked_generic")
        case .quotaRework: return L.t("hold_quota_rework")
        case .quotaReview: return L.t("hold_quota_review")
        case .quotaError: return L.t("hold_quota_error")
        case .quotaPlan: return L.t("hold_quota_plan")
        case .planRework: return L.t("hold_plan_rework", String(params?.round ?? 0), String(params?.cap ?? 0))
        case .planQuestion: return L.t("hold_plan_question")
        case .criticRework: return L.t("hold_critic_rework", String(params?.findings ?? 0))
        case .ciRed: return L.t("hold_ci_red")
        case .prConflict: return L.t("hold_pr_conflict")
        case .awaitingMerge: return L.t("hold_awaiting_merge")
        case .trainError: return L.t("hold_train_error")
        case .stalled: return L.t("hold_stalled")
        case .recapAttention: return L.t("hold_recap_attention")
        case .merging: return L.t("hold_merging")
        case .mergeRebasing: return L.t("hold_merge_rebasing", String(params?.rebaseCount ?? 0))
        case .readyMerge: return L.t("hold_ready_merge")
        case .manualSteps: return L.t("hold_manual_steps", String(params?.steps ?? 1))
        case nil: return hold.code.rawValue
        }
    }
}
