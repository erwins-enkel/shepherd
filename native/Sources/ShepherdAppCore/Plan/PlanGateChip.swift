import ShepherdKit

/// Abandonment window for the final plan rework round, in milliseconds.
/// Mirrors `ui/src/lib/plan-status.ts`.
let PLAN_FINAL_ROUND_TIMEOUT_MS = 900_000

enum PlanStallStatus: Equatable, Sendable {
    case round
    case final
    case stalled
}

/// A nil reason permits a review only when `canOfferPlanReview` also offers the control.
public enum PlanReviewBlockReason: Equatable, Sendable {
    case reviewing
    case approved
}

/// The eight chip states from `ui/src/lib/components/plan-gate-badge.ts`.
public enum PlanGateChip: Equatable, Sendable {
    case none
    case view
    case edited
    case reviewing
    case changes(round: Int, cap: Int)
    case ready
    case error
    case planning

    /// Priority is significant: absent phase, execution, reviewing, changes, ready, error,
    /// then planning. Dense lists suppress the read-only execution chip with `allowView: false`.
    public static func chip(
        session: Session, gate: PlanGate?, reviewing: Bool, allowView: Bool = true
    ) -> PlanGateChip {
        guard let phase = session.planPhase else { return .none }
        if phase.known == .executing {
            guard let gate, allowView else { return .none }
            return edited(gate) ? .edited : .view
        }
        if reviewing { return .reviewing }
        if gate?.decision.known == .changesRequested {
            return .changes(round: gate?.round ?? 0, cap: gate?.cap ?? 0)
        }
        if gate?.approved == true { return .ready }
        if gate?.decision.known == .error { return .error }
        return .planning
    }

    /// The only source of the edited chip and bypass for re-reviewing an approved gate.
    public static func edited(_ gate: PlanGate?) -> Bool {
        guard let gate, gate.approved, let livePlanHash = gate.livePlanHash else { return false }
        return livePlanHash != gate.planHash
    }

    static func canRelease(session: Session, gate: PlanGate?) -> Bool {
        gate?.approved == true && session.planPhase?.known == .planning
    }

    /// Structural eligibility for the panel's Resume/Dismiss actions; no clock is involved.
    static func canShowPlanStallActions(
        session: Session, gate: PlanGate?, reviewing: Bool
    ) -> Bool {
        guard let gate else { return false }
        return session.planPhase?.known == .planning
            && session.status.known != .running
            && !reviewing
            && gate.decision.known == .changesRequested
            && gate.round >= gate.cap
    }

    /// Badge tone also needs a genuinely stalled round, excluding a fresh final rework round.
    public static func stalledNow(
        session: Session, gate: PlanGate?, reviewing: Bool, now: Int
    ) -> Bool {
        guard let gate else { return false }
        return canShowPlanStallActions(session: session, gate: gate, reviewing: reviewing)
            && stallStatus(gate, now: now) == .stalled
    }

    /// `now` and the generated `updatedAt` are Unix timestamps in milliseconds.
    static func stallStatus(_ gate: PlanGate, now: Int) -> PlanStallStatus {
        if gate.round < gate.cap { return .round }
        if gate.finalRoundPending != true { return .stalled }
        if now - gate.updatedAt > PLAN_FINAL_ROUND_TIMEOUT_MS { return .stalled }
        return .final
    }

    static func canOfferPlanReview(session: Session, gate: PlanGate?) -> Bool {
        if session.planPhase?.known == .planning { return true }
        return session.planPhase?.known == .executing && edited(gate)
    }

    /// Returns the explanatory block reason so the offered button can remain focusable.
    /// An in-flight review takes priority over a stale approval.
    static func canTriggerPlanReview(
        session: Session, gate: PlanGate?, reviewing: Bool
    ) -> PlanReviewBlockReason? {
        guard canOfferPlanReview(session: session, gate: gate) else { return nil }
        if reviewing { return .reviewing }
        if gate?.approved == true && !edited(gate) { return .approved }
        return nil
    }

    /// Mirrors `tab-signal.svelte.ts`: question IDs are scoped to their form block.
    static func questionsUnanswered(_ gate: PlanGate?) -> Bool {
        guard let blocks = gate?.blocks else { return false }
        let answered = gate?.answeredQuestionKeys ?? []
        for block in blocks {
            guard let form = block.value13 else { continue }
            for question in form.questions {
                // The server persists this exact single-space separator.
                if !answered.contains("\(form.id) \(question.id)") { return true }
            }
        }
        return false
    }
}
