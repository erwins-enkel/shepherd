import ShepherdKit
import SwiftUI
import Testing

@testable import ShepherdAppCore

extension CoreSeamTests {
@MainActor
struct HerdStepperTests {
    private func session(phase: String? = "implementing") -> Session {
        var session = PreviewData.session()
        session.planPhase = phase.map { .init(value1: .init(rawValue: $0), value2: $0) }
        session.readyToMerge = false
        return session
    }

    private func git(state: PrStateKnown = .open, checks: ChecksStateKnown = .success) -> GitState {
        var git = GitState(state: .init(known: state), checks: .init(known: checks), deployConfigured: false)
        git.headSha = "head"
        git.mergeable = true
        return git
    }

    private func verdict(_ decision: ReviewDecisionKnown) -> ReviewVerdict {
        ReviewVerdict(sessionId: "s1", headSha: "head", decision: .init(known: decision),
            summary: "review", body: "review", findings: [], addressRound: 1, addressCap: 3,
            finalRoundPending: false, finalRoundTimeoutMs: 900_000, updatedAt: 0)
    }

    private func stepper(
        phase: String? = "implementing", git: GitState? = nil,
        verdict: ReviewVerdict? = nil, reviewing: Bool = false
    ) -> HerdStepper {
        HerdStepper(info: HerdClassifier.deriveStage(session: session(phase: phase), git: git,
            verdict: verdict, reviewing: reviewing))
    }

    @Test func aPromptStartsAtPlanningOrImplementing() {
        let planning = stepper(phase: "planning")
        #expect(planning.segments.map(\.stage) == [.planning, .implementing, .pr, .review, .ready])
        #expect(planning.segments.map(\.state) == [.active, .pending, .pending, .pending, .pending])
        #expect(stepper().segments.map(\.state) == [.done, .active, .pending, .pending, .pending])
        #expect(planning.segments.allSatisfy { $0.tint == nil })
    }

    @Test func anOpenPrWithPendingCiTintsOnlyThePrSegment() {
        let model = stepper(git: git(checks: .pending))
        #expect(model.segments.map(\.state) == [.done, .done, .active, .pending, .pending])
        #expect(model.segments.map(\.tint) == [nil, nil, .ciPending, nil, nil])
        #expect(model.segments[2].color == .orange)
        #expect(model.accessibilityLabel.contains(L.t("activity_ci_status", L.t("activity_ci_pending"))))
    }

    @Test func freshChangesRequestedEmphasizesReviewByShapeAndText() {
        let model = stepper(git: git(), verdict: verdict(.changesRequested))
        #expect(model.segments.map(\.state) == [.done, .done, .done, .active, .pending])
        #expect(model.segments.map(\.tint) == [nil, nil, .ciSuccess, .changes, nil])
        let review = model.segments[3]
        #expect(review.height > model.segments[2].height)
        #expect(review.outlineWidth > 0)
        #expect(review.color == .red)
        #expect(review.accessibilityLabel.contains(L.t("activity_review_changes")))
        #expect(model.accessibilityLabel.contains(L.t("activity_review_status", L.t("activity_review_changes"))))
    }

    @Test func failedCiHasTheSameNonColourCueAsChangesRequested() {
        let model = stepper(git: git(checks: .failure))
        let pr = model.segments[2]
        #expect(pr.tint == .ciFailure)
        #expect(pr.height > model.segments[1].height)
        #expect(pr.outlineWidth > 0)
        #expect(pr.color == .red)
        #expect(pr.accessibilityLabel.contains(L.t("activity_ci_failure")))
    }

    @Test func approvedAndGreenDerivesReadyWithoutAManualReadyFlag() {
        var approved = git()
        approved.latestReview = .init(state: .init(value1: .approved, value2: "approved"),
            author: "reviewer", submittedAt: 0)
        let model = stepper(git: approved)
        #expect(model.segments.map(\.state) == [.done, .done, .done, .done, .active])
        #expect(model.segments.map(\.tint) == [nil, nil, .ciSuccess, .approved, nil])
        #expect(model.segments[2].color == .green)
        #expect(model.segments[3].color == .green)
        #expect(model.terminal == nil)
    }

    @Test func terminalChipsReplaceEverySegment() {
        for state in [PrStateKnown.merged, .closed] {
            let model = stepper(git: git(state: state))
            #expect(model.segments.isEmpty)
            #expect(model.terminal == (state == .merged ? .merged : .closed))
            #expect(model.accessibilityLabel == (state == .merged ? L.t("activity_merged") : L.t("activity_closed")))
        }
    }

    @Test func absentPlanPhaseMakesPlanningHollowAndSkipped() {
        let model = stepper(phase: nil)
        #expect(model.segments.map(\.state) == [.skipped, .active, .pending, .pending, .pending])
        #expect(model.segments[0].isHollow)
        #expect(model.segments[0].outlineWidth > 0)
        #expect(model.segments[0].accessibilityLabel.contains(L.t("stepper_legend_skipped")))
    }

    @Test func reviewInFlightUsesAmberRatherThanApprovalGreen() {
        let model = stepper(git: git(), reviewing: true)
        #expect(model.segments[3].state == .active)
        #expect(model.segments[3].tint == .reviewing)
        #expect(model.segments[3].color == .orange)
        #expect(model.segments[3].outlineWidth == 0)
    }

    @Test func absentAndErrorReviewsStayUntinted() {
        for review in [StepperReviewTint.none, .error] {
            let model = HerdStepper(info: StepperInfo(reached: .review, ci: .init(known: .none),
                terminal: nil, review: review, planningSkipped: false))
            #expect(model.segments.allSatisfy { $0.tint == nil })
            #expect(model.segments[3].outlineWidth == 0)
            #expect(model.accessibilityLabel == L.t("activity_progress", L.t("activity_stage_review")))
        }
    }

    @Test func unreachedSegmentsNeverReceiveVerdictTints() {
        let model = HerdStepper(info: StepperInfo(reached: .implementing, ci: .init(known: .failure),
            terminal: nil, review: .changes, planningSkipped: false))
        #expect(model.segments.allSatisfy { $0.tint == nil && $0.outlineWidth == 0 })
        #expect(model.accessibilityLabel == L.t("activity_progress", L.t("activity_stage_implementing")))
    }
}
}
