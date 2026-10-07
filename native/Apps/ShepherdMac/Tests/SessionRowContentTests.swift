import Foundation
import ShepherdKit
import Testing

@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
@MainActor
struct SessionRowContentTests {
    private let now = 1_800_000_000_000

    private func session() -> Session {
        var session = PreviewData.session(status: .init(known: .done))
        session.repoPath = "/repos/shepherd/"
        session.createdAt = now - 545_000
        return session
    }

    private func activity(model: String? = nil, effort: String? = nil) -> SessionActivitySignal {
        .init(lastActivityTs: now, summary: "Updated the agent cards", recentTs: [], recentErrTs: [],
              runtimeModel: model, runtimeEffort: effort)
    }

    private func gate() -> PlanGate {
        .init(sessionId: "s1", planHash: "hash", decision: .init(known: .changesRequested),
              summary: "Review", body: "", findings: [], round: 1, cap: 3,
              approved: false, plan: "# Plan", updatedAt: now)
    }

    @Test func runtimeTelemetryWinsIndependentlyForModelAndEffort() {
        var row = session()
        row.model = "opus"
        row.effort = "high"
        row.runtimeModel = "claude-opus-5-5"
        row.runtimeEffort = "medium"
        let content = SessionRowContent(session: row,
            activity: activity(model: "gpt-6.1-sol", effort: "xhigh"), now: now)
        #expect(content.repository == "shepherd")
        #expect(content.model == "GPT-6.1 Sol")
        #expect(content.effort == L.t("effort_label_xhigh"))
        #expect(content.modelNote == L.t("session_env_model_observed", "GPT-6.1 Sol"))
        #expect(content.effortNote == L.t("session_env_effort_observed", L.t("effort_label_xhigh")))

        row.runtimeEffort = nil
        let mixed = SessionRowContent(session: row, activity: activity(model: "claude-opus-5-5"), now: now)
        #expect(mixed.model == "Opus 5.5")
        #expect(mixed.effort == L.t("effort_label_high"))
        #expect(mixed.effortNote == L.t("session_env_effort_configured", L.t("effort_label_high")))
    }

    @Test func persistedRuntimeSurvivesParkingAndFloatingAliasesStayHistorical() {
        var row = session()
        row.model = "opus"
        row.runtimeModel = "claude-opus-5-5-20260901"
        #expect(SessionRowContent(session: row, now: now).model == "Opus 5.5")
        #expect(SessionRowContent(session: row, activity: activity(model: ""), now: now).model == "Opus 5.5")
        row.runtimeModel = nil
        #expect(SessionRowContent(session: row, now: now).model == "opus")
        row.model = "opus[1m]"
        #expect(SessionRowContent(session: row, now: now).model == L.t("model_label_opus_1m"))
        row.model = nil
        let unknown = SessionRowContent(session: row, now: now)
        #expect(unknown.environment == L.t("newtask_model_default"))
        #expect(unknown.effortNote == nil)
        row.model = ""
        row.effort = ""
        #expect(SessionRowContent(session: row, activity: activity(model: "", effort: ""), now: now).environment
            == L.t("newtask_model_default"))
    }

    @Test func futureModelAndEffortValuesRemainVisible() {
        let content = SessionRowContent(session: session(),
            activity: activity(model: "future-engine", effort: "future-effort"), now: now)
        #expect(content.environment == "future-engine · future-effort")
    }

    @Test func elapsedMatchesTheWebAtMinuteHourAndDayBoundaries() {
        for (age, expected) in [(0, "00:00"), (59_000, "00:59"), (60_000, "01:00"),
                                (3_599_000, "59:59"), (3_600_000, "1h 00m"),
                                (86_399_000, "23h 59m"), (86_400_000, "1d 00h"),
                                (176_400_000, "2d 01h"), (-1_000, "00:00")] {
            #expect(SessionRowContent.elapsed(now - age, now: now) == expected)
        }
    }

    @Test func parkedRowsExplainTheirHoldBeforeShowingRecapOrActivity() {
        var row = session()
        row.planPhase = .init(known: .planning)
        let hold = HoldReason(code: .init(known: .ciRed))
        let content = SessionRowContent(session: row, activity: activity(), hold: hold,
            gate: gate(), planReviewing: true, now: now)
        #expect(content.note == L.t("hold_ci_red"), "a plan review must not mask a non-plan hold")
        let future = SessionRowContent(session: row,
            hold: .init(code: .init(unknown: "future-hold")), now: now)
        #expect(future.note == "future-hold")
        #expect(SessionRowContent(session: session(), activity: activity(), now: now).note == "Updated the agent cards")
    }

    @Test func planNotesFollowReviewReworkCapAndApproval() {
        var row = session()
        row.planPhase = .init(known: .planning)
        var plan = gate()
        #expect(SessionRowContent(session: row, gate: plan, planReviewing: true, now: now).note
            == L.t("hold_reviewing_plain"))
        row.status = .init(known: .running)
        #expect(SessionRowContent(session: row, gate: plan, now: now).note == L.t("hold_revising_round", "1", "3"))
        row.status = .init(known: .done)
        #expect(SessionRowContent(session: row, gate: plan, now: now).note == L.t("hold_awaiting_rereview", "1", "3"))
        plan.round = 3
        #expect(SessionRowContent(session: row, gate: plan, now: now).note == L.t("hold_quota_plan"))
        plan.decision = .init(known: .approved)
        plan.approved = true
        #expect(SessionRowContent(session: row, gate: plan, now: now).note == L.t("hold_ready"))
    }

    @Test func coldResumeRequiresParkedStateExpiredCacheAndMaterialCost() throws {
        var row = session()
        row.contextTokens = 150_000
        row.additionalProperties = try .init(unvalidatedValue: ["coldResumeAt": now, "resumeCostUnits": 1.9])
        #expect(SessionRowContent(session: row, now: now).coldResume == nil)
        #expect(SessionRowContent(session: row, now: now + 1).coldResume != nil)
        #expect(SessionRowContent(session: row, now: now + 1).coldResumeNote?.contains("{") == false)
        for status in [SessionStatusKnown.running, .archived] {
            row.status = .init(known: status)
            #expect(SessionRowContent(session: row, now: now + 1).coldResume == nil)
        }
        row.status = .init(known: .done)
        row.additionalProperties = try .init(unvalidatedValue: ["coldResumeAt": now - 1, "resumeCostUnits": 0.49])
        #expect(SessionRowContent(session: row, now: now).coldResume == nil)
        row.additionalProperties = try .init(unvalidatedValue: ["coldResumeAt": now - 1])
        #expect(SessionRowContent(session: row, now: now).coldResume == nil)
    }

    @Test func holdNotesKeepParametersAndQuestionText() {
        let cases: [(HoldReason, String)] = [
            (.init(code: .init(known: .planRework), params: .init(round: 2, cap: 4)), L.t("hold_plan_rework", "2", "4")),
            (.init(code: .init(known: .criticRework), params: .init(findings: 5)), L.t("hold_critic_rework", "5")),
            (.init(code: .init(known: .manualSteps), params: .init(steps: 2)), L.t("hold_manual_steps", "2")),
            (.init(code: .init(known: .autopilotPaused), params: .init(question: "  Which target?  ")), "Which target?"),
        ]
        for (hold, expected) in cases {
            #expect(SessionRowContent(session: session(), hold: hold, now: now).note == expected)
        }
    }
}
}
