import ShepherdKit
import Testing

@testable import ShepherdAppCore

extension CoreSeamTests {
@MainActor
struct PlanGateChipTests {
    private let updatedAt = 1_800_000_000_000

    private func session(_ phase: String? = "planning", status: String = "idle") -> Session {
        var session = PreviewData.session(status: SessionStatus(value1: .init(rawValue: status), value2: status))
        session.planPhase = phase.map { .init(value1: .init(rawValue: $0), value2: $0) }
        return session
    }

    private func gate(
        decision: String = "changes_requested", approved: Bool = false,
        round: Int = 3, cap: Int = 3, livePlanHash: String? = nil,
        finalRoundPending: Bool? = nil
    ) -> PlanGate {
        PlanGate(
            sessionId: "s1", planHash: "reviewed", decision: .init(value1: .init(rawValue: decision), value2: decision),
            summary: "Review", body: "Findings", findings: [], round: round, cap: cap,
            approved: approved, plan: "# Plan", livePlanHash: livePlanHash,
            finalRoundPending: finalRoundPending, updatedAt: updatedAt)
    }

    @Test func absentPhaseWinsOverEveryGateAndReview() {
        for gate in [nil, gate(), gate(approved: true, livePlanHash: "edited"), gate(decision: "error")] {
            for reviewing in [false, true] {
                #expect(PlanGateChip.chip(session: session(nil), gate: gate, reviewing: reviewing) == .none)
            }
        }
    }

    @Test func executingIsReadOnlyBeforeReviewingOrVerdicts() {
        for reviewing in [false, true] {
            #expect(PlanGateChip.chip(session: session("executing"), gate: nil, reviewing: reviewing) == .none)
            for gate in [gate(), gate(decision: "error"), gate(approved: true)] {
                #expect(PlanGateChip.chip(session: session("executing"), gate: gate, reviewing: reviewing) == .view)
                #expect(PlanGateChip.chip(session: session("executing"), gate: gate, reviewing: reviewing, allowView: false) == .none)
            }
            let edited = gate(approved: true, livePlanHash: "edited")
            #expect(PlanGateChip.chip(session: session("executing"), gate: edited, reviewing: reviewing) == .edited)
            #expect(PlanGateChip.chip(session: session("executing"), gate: edited, reviewing: reviewing, allowView: false) == .none)
        }
    }

    @Test func planningPriorityIsReviewingThenChangesThenReadyThenErrorThenPlanning() {
        let cases: [(PlanGate?, Bool, PlanGateChip)] = [
            (nil, true, .reviewing),
            (gate(approved: true), true, .reviewing),
            (gate(decision: "error", approved: true), true, .reviewing),
            (gate(approved: true, round: 4, cap: 3), false, .changes(round: 4, cap: 3)),
            (gate(round: 0, cap: 0), false, .changes(round: 0, cap: 0)),
            (gate(decision: "error", approved: true), false, .ready),
            (gate(decision: "approved", approved: true), false, .ready),
            (gate(decision: "error"), false, .error),
            (gate(decision: "approved"), false, .planning),
            (gate(decision: "future-verdict"), false, .planning),
            (nil, false, .planning),
        ]
        for (gate, reviewing, expected) in cases {
            // The web falls through for an unfamiliar non-null phase; allowView affects execution only.
            for phase in ["planning", "future-phase"] {
                for allowView in [false, true] {
                    #expect(PlanGateChip.chip(session: session(phase), gate: gate, reviewing: reviewing, allowView: allowView) == expected)
                }
            }
        }
    }

    @Test func editedRequiresApprovalAndAPresentDifferentHash() {
        #expect(!PlanGateChip.edited(nil))
        #expect(!PlanGateChip.edited(gate(livePlanHash: "edited")))
        #expect(!PlanGateChip.edited(gate(approved: true)))
        #expect(!PlanGateChip.edited(gate(approved: true, livePlanHash: "reviewed")))
        #expect(PlanGateChip.edited(gate(approved: true, livePlanHash: "edited")))
        // The task explicitly specifies presence (non-nil), including an empty but present hash.
        #expect(PlanGateChip.edited(gate(approved: true, livePlanHash: "")))
    }

    @Test func releaseRequiresTheApprovalFlagAndPlanningPhase() {
        #expect(PlanGateChip.canRelease(session: session(), gate: gate(approved: true)))
        #expect(PlanGateChip.canRelease(session: session(), gate: gate(approved: true, livePlanHash: "edited")))
        #expect(!PlanGateChip.canRelease(session: session(), gate: gate(decision: "approved")))
        #expect(!PlanGateChip.canRelease(session: session(), gate: nil))
        for phase in [nil, "executing", "future-phase"] {
            #expect(!PlanGateChip.canRelease(session: session(phase), gate: gate(approved: true)))
        }
    }

    @Test func stallActionsRequireAllFiveStructuralTerms() {
        #expect(PlanGateChip.canShowPlanStallActions(session: session(), gate: gate(), reviewing: false))
        #expect(PlanGateChip.canShowPlanStallActions(session: session(status: "blocked"), gate: gate(round: 4), reviewing: false))
        #expect(PlanGateChip.canShowPlanStallActions(session: session(status: "future-status"), gate: gate(), reviewing: false))
        let excluded: [(Session, PlanGate?, Bool)] = [
            (session(nil), gate(), false), (session("executing"), gate(), false),
            (session("future-phase"), gate(), false),
            (session(status: "running"), gate(), false), (session(), gate(), true),
            (session(), gate(decision: "error"), false),
            (session(), gate(decision: "approved", approved: true), false),
            (session(), gate(decision: "future-verdict"), false),
            (session(), gate(round: 2), false), (session(), nil, false),
        ]
        for (session, gate, reviewing) in excluded {
            #expect(!PlanGateChip.canShowPlanStallActions(session: session, gate: gate, reviewing: reviewing))
            #expect(!PlanGateChip.stalledNow(session: session, gate: gate, reviewing: reviewing, now: updatedAt + 900_001))
        }
    }

    @Test func belowCapRemainsRoundEvenAfterTheTimeout() {
        for pending in [nil, false, true] {
            #expect(PlanGateChip.stallStatus(gate(round: 2, finalRoundPending: pending), now: updatedAt + 900_001) == .round)
        }
    }

    @Test func atOrAboveCapWithoutAPendingFinalRoundIsStalled() {
        for round in [3, 4] {
            for pending in [nil, false] {
                #expect(PlanGateChip.stallStatus(gate(round: round, finalRoundPending: pending), now: updatedAt) == .stalled)
            }
        }
    }

    @Test func finalRoundTimesOutStrictlyAfter900000Milliseconds() {
        for round in [3, 4] {
            let gate = gate(round: round, finalRoundPending: true)
            for elapsed in [-1, 0, 899_999, 900_000] {
                #expect(PlanGateChip.stallStatus(gate, now: updatedAt + elapsed) == .final)
            }
            #expect(PlanGateChip.stallStatus(gate, now: updatedAt + 900_001) == .stalled)
        }
    }

    @Test func freshFinalRoundOffersActionsWithoutToningTheBadgeStalled() {
        let finalGate = gate(finalRoundPending: true)
        #expect(PlanGateChip.canShowPlanStallActions(session: session(), gate: finalGate, reviewing: false))
        #expect(!PlanGateChip.stalledNow(session: session(), gate: finalGate, reviewing: false, now: updatedAt + 900_000))
        #expect(PlanGateChip.stalledNow(session: session(), gate: finalGate, reviewing: false, now: updatedAt + 900_001))
        #expect(PlanGateChip.stalledNow(session: session(), gate: gate(), reviewing: false, now: updatedAt))
    }

    @Test func reviewIsOfferedDuringPlanningOrEditedApprovedExecutionOnly() {
        for gate in [nil, gate(), gate(approved: true), gate(approved: true, livePlanHash: "edited")] {
            #expect(PlanGateChip.canOfferPlanReview(session: session(), gate: gate))
            for phase in [nil, "future-phase"] {
                #expect(!PlanGateChip.canOfferPlanReview(session: session(phase), gate: gate))
            }
        }
        for gate in [nil, gate(), gate(livePlanHash: "edited"), gate(approved: true), gate(approved: true, livePlanHash: "reviewed")] {
            #expect(!PlanGateChip.canOfferPlanReview(session: session("executing"), gate: gate))
        }
        #expect(PlanGateChip.canOfferPlanReview(session: session("executing"), gate: gate(approved: true, livePlanHash: "edited")))
    }

    @Test func reviewBlockReasonsPreserveVisibilityAndPrioritizeInflight() {
        #expect(PlanGateChip.canTriggerPlanReview(session: session(), gate: gate(approved: true), reviewing: true) == .reviewing)
        #expect(PlanGateChip.canTriggerPlanReview(session: session(), gate: nil, reviewing: true) == .reviewing)
        #expect(PlanGateChip.canTriggerPlanReview(session: session(), gate: gate(approved: true), reviewing: false) == .approved)
        #expect(PlanGateChip.canTriggerPlanReview(session: session(), gate: gate(approved: true, livePlanHash: "reviewed"), reviewing: false) == .approved)
        for phase in ["planning", "executing"] {
            let edited = gate(approved: true, livePlanHash: "edited")
            #expect(PlanGateChip.canTriggerPlanReview(session: session(phase), gate: edited, reviewing: false) == nil)
            #expect(PlanGateChip.canTriggerPlanReview(session: session(phase), gate: edited, reviewing: true) == .reviewing)
        }
        for gate in [nil, gate(round: 4), gate(decision: "error"), gate(decision: "approved")] {
            #expect(PlanGateChip.canTriggerPlanReview(session: session(), gate: gate, reviewing: false) == nil)
        }
        for phase in [nil, "executing", "future-phase"] {
            #expect(PlanGateChip.canTriggerPlanReview(session: session(phase), gate: gate(approved: true), reviewing: true) == nil)
        }
    }

    private func form(_ id: String, questions: [String]) -> VisualBlock {
        .init(value13: .init(
            _type: .questionForm, id: id,
            questions: questions.map { .init(id: $0, prompt: "Choose", kind: .init(known: .single)) }))
    }

    @Test func noQuestionsMeansNoUnansweredSignal() {
        #expect(!PlanGateChip.questionsUnanswered(nil))
        var gate = gate()
        #expect(!PlanGateChip.questionsUnanswered(gate))
        gate.blocks = []
        #expect(!PlanGateChip.questionsUnanswered(gate))
        gate.blocks = [
            .init(value1: .init(_type: .richText, id: "text", markdown: "Plan")),
            .init(value14: .init(_type: "future-block", markdown: "Fallback")),
            form("empty", questions: []),
        ]
        #expect(!PlanGateChip.questionsUnanswered(gate))
    }

    @Test func everyQuestionInEveryFormNeedsItsOwnBlockScopedAnswer() {
        var gate = gate()
        gate.blocks = [form("b1", questions: ["q1", "q2"]), form("b2", questions: ["q1"])]
        #expect(PlanGateChip.questionsUnanswered(gate))
        gate.answeredQuestionKeys = []
        #expect(PlanGateChip.questionsUnanswered(gate))
        gate.answeredQuestionKeys = ["b1 q1", "b1 q2"]
        #expect(PlanGateChip.questionsUnanswered(gate))
        gate.answeredQuestionKeys = ["b1 q1", "b2 q1"]
        #expect(PlanGateChip.questionsUnanswered(gate))
        gate.answeredQuestionKeys = ["b1 q1", "b1 q2", "b2 q1", "unrelated q9"]
        #expect(!PlanGateChip.questionsUnanswered(gate))
    }

    @Test func answerKeySeparatorIsLiterallyOneSpace() {
        var gate = gate()
        gate.blocks = [form("block", questions: ["question"])]
        for wrong in ["block:question", "block/question", "block  question", "block\tquestion", "question"] {
            gate.answeredQuestionKeys = [wrong]
            #expect(PlanGateChip.questionsUnanswered(gate))
        }
        gate.answeredQuestionKeys = ["block question"]
        #expect(!PlanGateChip.questionsUnanswered(gate))
    }
}
}
