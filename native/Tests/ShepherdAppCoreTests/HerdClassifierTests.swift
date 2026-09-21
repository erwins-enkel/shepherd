import Foundation
import ShepherdKit
import Testing

@testable import ShepherdAppCore

extension CoreSeamTests {
struct HerdClassifierTests {
    @Test func checksNoneOnAnOpenPrIsNotClearedUnlessTheRepoHasNoCi() {
        #expect(!HerdClassifier.checksCleared(.init(known: .none), noCi: false))
        #expect(HerdClassifier.checksCleared(.init(known: .none), noCi: true))
        #expect(HerdClassifier.checksCleared(.init(known: .success), noCi: false))
        #expect(!HerdClassifier.checksCleared(.init(known: .failure), noCi: true))
        #expect(!HerdClassifier.checksCleared(.init(known: .pending), noCi: true))
        #expect(!HerdClassifier.checksCleared(.init(unknown: "future"), noCi: true))
    }

    // herd-partition.ts: merged > merging > idle review block > protection > ready > review
    // > rework > pending CI > failed CI > draft/handoff > active.
    @Test func mergedOutranksEverything() {
        let session = Fixtures.session(readyToMerge: true, mergingSince: 0)
        #expect(HerdClassifier.stage(session, git: Fixtures.git(state: .merged, checks: .failure),
            ctx: .init(reviewing: true, planRework: true)) == .merged)
    }

    @Test func mergingOutranksReworkAndReadyUntilTheExactExpiry() {
        let session = Fixtures.session(readyToMerge: true, mergingSince: 0)
        let git = Fixtures.git(reviewBlock: Fixtures.reviewBlock)
        #expect(HerdClassifier.stage(session, git: git, ctx: .idle) == .merging)
        #expect(HerdClassifier.stage(session, git: git,
            ctx: .init(now: HerdPartition.mergingWindowMs)) == .needsRework)
        #expect(HerdClassifier.stage(session, git: nil, ctx: .idle) == .merging)
    }

    @Test func readyOutranksBothReviewerRunningAndCi() {
        let session = Fixtures.session(readyToMerge: true)
        #expect(HerdClassifier.stage(session, git: Fixtures.git(checks: .pending),
            ctx: .init(reviewing: true)) == .ready)
        #expect(HerdClassifier.stage(session, git: nil, ctx: .idle) == .ready)
        #expect(HerdClassifier.stage(Fixtures.session(status: .running, readyToMerge: true),
            git: Fixtures.git(checks: .failure), ctx: .init(planRework: true)) == .ready)
    }

    @Test func needsReworkNeedsAllSixTermsOfIdleOpenCleared() {
        let git = Fixtures.git(reviewBlock: Fixtures.reviewBlock)
        #expect(HerdClassifier.stage(Fixtures.session(), git: git, ctx: .idle) == .needsRework)
        #expect(HerdClassifier.stage(Fixtures.session(status: .running), git: git, ctx: .idle) == .active)
        #expect(HerdClassifier.stage(Fixtures.session(status: .blocked), git: git, ctx: .idle) == .active)
        #expect(HerdClassifier.stage(Fixtures.session(), git: git,
            ctx: .init(reviewing: true)) == .reviewerRunning)
        #expect(HerdClassifier.stage(Fixtures.session(),
            git: Fixtures.git(checks: .pending, reviewBlock: Fixtures.reviewBlock), ctx: .idle) == .ciRunning)
        #expect(HerdClassifier.stage(Fixtures.session(),
            git: Fixtures.git(state: .closed, reviewBlock: Fixtures.reviewBlock), ctx: .idle) == .active)
        #expect(!HerdClassifier.isIdleOpenCleared(Fixtures.session(), git: nil, ctx: .idle))
        #expect(!HerdClassifier.isIdleOpenCleared(Fixtures.session(status: .running), git: git,
            ctx: .init(planRework: true)))
        #expect(HerdClassifier.stage(Fixtures.session(readyToMerge: true), git: git, ctx: .idle) == .needsRework)
    }

    @Test func branchProtectionBlockedNeedsNoReviewBlock() {
        let blocked = Fixtures.git(mergeStateStatus: .blocked)
        #expect(HerdClassifier.stage(Fixtures.session(readyToMerge: true), git: blocked,
            ctx: .idle) == .branchProtectionBlocked)
        #expect(HerdClassifier.stage(Fixtures.session(),
            git: Fixtures.git(mergeStateStatus: .blocked, reviewBlock: Fixtures.reviewBlock),
            ctx: .idle) == .needsRework)
    }

    @Test func reviewerRunningOutranksReworkAndCiWithoutNeedingGit() {
        let session = Fixtures.session(status: .running)
        let ctx = HerdContext(reviewing: true, planRework: true)
        #expect(HerdClassifier.stage(session, git: Fixtures.git(checks: .failure), ctx: ctx) == .reviewerRunning)
        #expect(HerdClassifier.stage(session, git: nil, ctx: ctx) == .reviewerRunning)
    }

    @Test func reworkRunningOutranksCiAndForwardsWorkingBlocked() {
        let session = Fixtures.session(status: .blocked)
        let ctx = HerdContext(workingBlocked: [session.id: true], verdict: Fixtures.verdict())
        #expect(HerdClassifier.stage(session, git: Fixtures.git(checks: .pending), ctx: ctx) == .reworkRunning)
        #expect(HerdClassifier.stage(session, git: nil, ctx: ctx) == .reworkRunning)
        #expect(HerdClassifier.stage(Fixtures.session(status: .running),
            git: Fixtures.git(checks: .failure), ctx: .init(planRework: true)) == .reworkRunning)
    }

    @Test func ciRunningRequiresAnOpenPrAndOutranksDraftAndHandoff() {
        #expect(HerdClassifier.stage(Fixtures.session(),
            git: Fixtures.git(checks: .pending, isDraft: true, handoff: .reviewer), ctx: .idle) == .ciRunning)
        #expect(HerdClassifier.stage(Fixtures.session(),
            git: Fixtures.git(state: .closed, checks: .pending), ctx: .idle) == .active)
    }

    @Test func ciFailedRequiresAnOpenPrAndOutranksDraftAndHandoff() {
        #expect(HerdClassifier.stage(Fixtures.session(),
            git: Fixtures.git(checks: .failure, isDraft: true, handoff: .merger), ctx: .idle) == .ciFailed)
        #expect(HerdClassifier.stage(Fixtures.session(),
            git: Fixtures.git(state: .none, checks: .failure), ctx: .idle) == .active)
    }

    @Test func aGreenIdleDraftOutranksItsHandoff() {
        for handoff in [PrHandoffKnown.reviewer, .merger] {
            #expect(HerdClassifier.stage(Fixtures.session(),
                git: Fixtures.git(isDraft: true, handoff: handoff), ctx: .idle) == .draftAwaitingSignoff)
        }
    }

    @Test func waitingOnReviewerUsesHandoffAlone() {
        #expect(HerdClassifier.stage(Fixtures.session(), git: Fixtures.git(handoff: .reviewer),
            ctx: .idle) == .waitingOnReviewer)
    }

    @Test func waitingOnMergerUsesHandoffAlone() {
        #expect(HerdClassifier.stage(Fixtures.session(), git: Fixtures.git(handoff: .merger),
            ctx: .idle) == .waitingOnMerger)
    }

    @Test func theThreeHandoffStagesSplitOnHandoffAlone() {
        for (handoff, expected) in [
            (PrHandoffKnown.reviewer, HerdStage.waitingOnReviewer),
            (.merger, .waitingOnMerger),
        ] {
            let git = Fixtures.git(handoff: handoff)
            #expect(HerdClassifier.stage(Fixtures.session(), git: git, ctx: .idle) == expected)
        }
        #expect(HerdClassifier.stage(Fixtures.session(), git: Fixtures.git(), ctx: .idle) == .awaitingMerge)
    }

    @Test func awaitingMergeIncludesNoCiRepositoriesAndUnknownHandoffs() {
        #expect(HerdClassifier.stage(Fixtures.session(), git: Fixtures.git(), ctx: .idle) == .awaitingMerge)
        #expect(HerdClassifier.stage(Fixtures.session(), git: Fixtures.git(checks: .none, noCi: true),
            ctx: .idle) == .awaitingMerge)
        var git = Fixtures.git()
        git.handoff = .init(unknown: "future")
        #expect(HerdClassifier.handoffStage(git) == .awaitingMerge)
    }

    @Test func activeIsTheFallbackForMissingOrUnsettledGit() {
        #expect(HerdClassifier.stage(Fixtures.session(), git: nil, ctx: .idle) == .active)
        #expect(HerdClassifier.stage(Fixtures.session(), git: Fixtures.git(checks: .none), ctx: .idle) == .active)
        var git = Fixtures.git()
        git.state = .init(unknown: "future")
        #expect(HerdClassifier.stage(Fixtures.session(), git: git, ctx: .idle) == .active)
    }

    @Test func greenIdleUsesTheRawStatusNotTheDisplayStatus() {
        let blocked = Fixtures.session(status: .blocked)
        #expect(HerdClassifier.stage(blocked, git: Fixtures.git(handoff: .reviewer),
            ctx: .init(workingBlocked: [blocked.id: true])) == .active)
    }

    @Test func aStaleVerdictDoesNotTintTheStepper() {
        let git = Fixtures.git(headSha: "new")
        let verdict = Fixtures.verdict(headSha: "old")
        #expect(HerdClassifier.verdictStale(verdict, git: git))
        let info = HerdClassifier.deriveStage(session: Fixtures.session(), git: git,
            verdict: verdict, reviewing: false)
        #expect(info.review == .none)
        #expect(info.reached == .review) // A stale verdict still proves review was reached.
    }

    @Test func stalenessRequiresTwoNonemptyDifferentHeadsAndAnOpenPr() {
        let verdict = Fixtures.verdict(headSha: "old")
        #expect(!HerdClassifier.verdictStale(verdict, git: nil))
        #expect(!HerdClassifier.verdictStale(nil, git: Fixtures.git(headSha: "new")))
        for head in [nil, "", "old"] as [String?] {
            #expect(!HerdClassifier.verdictStale(verdict, git: Fixtures.git(headSha: head)))
        }
        #expect(!HerdClassifier.verdictStale(Fixtures.verdict(headSha: ""), git: Fixtures.git(headSha: "new")))
        for state in [PrStateKnown.none, .closed, .merged] {
            #expect(!HerdClassifier.verdictStale(verdict, git: Fixtures.git(state: state, headSha: "new")))
        }
    }

    @Test func reworkRunningNeedsALiveTurnAndAnUnstaleCriticVerdict() {
        let running = Fixtures.session(status: .running)
        let fresh = Fixtures.verdict(updatedAt: 0)
        #expect(HerdClassifier.isReworkRunning(running, verdict: fresh, now: 1, planRework: false))
        #expect(!HerdClassifier.isReworkRunning(Fixtures.session(), verdict: fresh, now: 1, planRework: false))
        #expect(!HerdClassifier.isReworkRunning(running, verdict: Fixtures.verdict(dismissed: true),
            now: 1, planRework: false))
        #expect(HerdClassifier.isReworkRunning(running, verdict: nil, now: 1, planRework: true))
        #expect(!HerdClassifier.isReworkRunning(Fixtures.session(), verdict: nil, now: 1, planRework: true))
        let blocked = Fixtures.session(status: .blocked)
        #expect(!HerdClassifier.isReworkRunning(blocked, verdict: fresh, now: 1, planRework: false))
        #expect(HerdClassifier.isReworkRunning(blocked, verdict: fresh, now: 1, planRework: false,
            workingBlocked: [blocked.id: true]))
        for decision in [ReviewDecisionKnown.commented, .error] {
            #expect(!HerdClassifier.isReworkRunning(running, verdict: Fixtures.verdict(decision: decision),
                now: 1, planRework: false))
        }
        #expect(!HerdClassifier.isReworkRunning(running, verdict: nil, now: 1, planRework: false))
    }

    @Test func addressRoundsRespectCapPendingTimeoutAndEmptyFindings() {
        #expect(HerdClassifier.addressStallStatus(Fixtures.verdict(), now: 1_000_000) == .round)
        let final = Fixtures.verdict(addressRound: 3, finalRoundPending: true)
        #expect(HerdClassifier.addressStallStatus(final, now: 900_000) == .final)
        #expect(HerdClassifier.addressStallStatus(final, now: 900_001) == .stalled)
        #expect(HerdClassifier.addressStallStatus(Fixtures.verdict(addressRound: 4), now: 0) == .stalled)
        #expect(HerdClassifier.addressStallStatus(Fixtures.verdict(findings: [], addressRound: 4),
            now: 1_000_000) == .round) // review-status.ts: transient errors hold the streak.
        let running = Fixtures.session(status: .running)
        #expect(HerdClassifier.isReworkRunning(running, verdict: final, now: 900_000, planRework: false))
        #expect(!HerdClassifier.isReworkRunning(running, verdict: final, now: 900_001, planRework: false))
    }

    @Test func readinessBlocksAreFirstMatchDraftConflictBehindBlocked() {
        #expect(HerdClassifier.prReadinessBlock(nil) == nil)
        #expect(HerdClassifier.prReadinessBlock(Fixtures.git(state: .closed, isDraft: true)) == nil)
        #expect(HerdClassifier.prReadinessBlock(Fixtures.git(mergeStateStatus: .dirty, isDraft: true)) == .draft)
        #expect(HerdClassifier.prReadinessBlock(Fixtures.git(mergeStateStatus: .dirty)) == .conflict)
        #expect(HerdClassifier.prReadinessBlock(Fixtures.git(mergeStateStatus: .behind, mergeable: false)) == .conflict)
        #expect(HerdClassifier.prReadinessBlock(Fixtures.git(mergeStateStatus: .behind)) == .behind)
        #expect(HerdClassifier.prReadinessBlock(Fixtures.git(mergeStateStatus: .blocked)) == .blocked)
        #expect(HerdClassifier.prReadinessBlock(Fixtures.git(mergeStateStatus: .unknown)) == nil)
        #expect(HerdClassifier.prReadinessBlock(Fixtures.git()) == nil)
    }

    @Test func stepperStagesHaveTheirOwnFiveStageOrder() {
        #expect(StepperStage.allCases == [.planning, .implementing, .pr, .review, .ready])
        let planning = HerdClassifier.deriveStage(session: Fixtures.session(planPhase: "planning"),
            git: nil, verdict: nil, reviewing: false)
        #expect(planning.reached == .planning && planning.index == 0 && !planning.planningSkipped)
        for phase in [nil, "executing", "future"] as [String?] {
            let info = HerdClassifier.deriveStage(session: Fixtures.session(planPhase: phase),
                git: nil, verdict: nil, reviewing: false)
            #expect(info.reached == .implementing && info.index == 1)
            #expect(info.planningSkipped == (phase == nil))
            #expect(info.ci.known == ChecksStateKnown.none && info.terminal == nil)
        }
        let pr = HerdClassifier.deriveStage(session: Fixtures.session(planPhase: "planning"),
            git: Fixtures.git(checks: .pending), verdict: nil, reviewing: false)
        #expect(pr.reached == .pr && pr.index == 2 && pr.ci.known == .pending)
        let review = HerdClassifier.deriveStage(session: Fixtures.session(), git: nil, verdict: nil, reviewing: true)
        #expect(review.reached == .review && review.index == 3 && review.review == .reviewing)
        let ready = HerdClassifier.deriveStage(session: Fixtures.session(readyToMerge: true),
            git: nil, verdict: nil, reviewing: false)
        #expect(ready.reached == .ready && ready.index == 4)
    }

    @Test func stepperDerivedReadyRequiresEveryMergeCondition() {
        let verdict = Fixtures.verdict(decision: .commented)
        var git = Fixtures.git(mergeable: true, headSha: "x")
        func reached(_ git: GitState) -> StepperStage {
            HerdClassifier.deriveStage(session: Fixtures.session(), git: git,
                verdict: verdict, reviewing: false).reached
        }
        #expect(reached(git) == .ready)
        git.headSha = nil
        #expect(reached(git) == .review)
        git.headSha = "other"
        #expect(reached(git) == .review)
        for candidate in [
            Fixtures.git(state: .closed, mergeable: true, headSha: "x"),
            Fixtures.git(checks: .none, noCi: true, mergeable: true, headSha: "x"),
            Fixtures.git(mergeable: nil, headSha: "x"),
            Fixtures.git(mergeable: false, headSha: "x"),
            Fixtures.git(isDraft: true, mergeable: true, headSha: "x"),
            Fixtures.git(mergeStateStatus: .behind, mergeable: true, headSha: "x"),
            Fixtures.git(mergeStateStatus: .blocked, mergeable: true, headSha: "x"),
        ] { #expect(reached(candidate) == .review) }
        let unreviewed = HerdClassifier.deriveStage(session: Fixtures.session(),
            git: Fixtures.git(mergeable: true), verdict: nil, reviewing: false)
        #expect(unreviewed.reached == .pr)
        let approved = HerdClassifier.deriveStage(session: Fixtures.session(),
            git: Fixtures.git(mergeable: true, latestReview: "approved"), verdict: nil, reviewing: false)
        #expect(approved.reached == .ready && approved.review == .approved)
    }

    @Test func stepperTerminalChipsDoNotConflateClosedWithReady() {
        let merged = HerdClassifier.deriveStage(session: Fixtures.session(),
            git: Fixtures.git(state: .merged), verdict: nil, reviewing: false)
        #expect(merged.terminal == .merged && merged.reached == .ready)
        let closed = HerdClassifier.deriveStage(session: Fixtures.session(),
            git: Fixtures.git(state: .closed), verdict: nil, reviewing: false)
        #expect(closed.terminal == .closed && closed.reached == .implementing)
    }

    @Test func reviewTintPrecedenceKeepsHumanReviewsIndependentOfCriticFreshness() {
        func tint(_ git: GitState?, _ verdict: ReviewVerdict?, reviewing: Bool = false) -> StepperReviewTint {
            HerdClassifier.deriveStage(session: Fixtures.session(), git: git, verdict: verdict,
                reviewing: reviewing).review
        }
        let approved = Fixtures.git(headSha: "x", latestReview: "approved")
        #expect(tint(approved, Fixtures.verdict(), reviewing: true) == .reviewing)
        #expect(tint(approved, Fixtures.verdict()) == .changes)
        #expect(tint(approved, Fixtures.verdict(decision: .error)) == .approved)
        #expect(tint(nil, Fixtures.verdict(decision: .error)) == .error)
        #expect(tint(Fixtures.git(headSha: "new"), Fixtures.verdict(decision: .error)) == .none)
        #expect(tint(Fixtures.git(headSha: "new", latestReview: "changes_requested"),
            Fixtures.verdict()) == .changes)
        #expect(tint(nil, nil) == .none)
    }
}
}

private enum Fixtures {
    static let reviewBlock = PrReviewBlock(reviewer: "r1", state: .changesRequested)

    static func session(
        status: SessionStatusKnown = .idle, readyToMerge: Bool = false,
        mergingSince: Int? = nil, planPhase: String? = nil
    ) -> Session {
        var session = PreviewData.session(status: .init(known: status))
        session.readyToMerge = readyToMerge
        session.mergingSince = mergingSince
        session.planPhase = planPhase.map { .init(value1: .init(rawValue: $0), value2: $0) }
        return session
    }

    static func git(
        state: PrStateKnown = .open, checks: ChecksStateKnown = .success,
        mergeStateStatus: MergeStateStatusKnown? = nil, isDraft: Bool = false,
        noCi: Bool = false, handoff: PrHandoffKnown? = nil, reviewBlock: PrReviewBlock? = nil,
        mergeable: Bool? = nil, headSha: String? = nil, latestReview: String? = nil
    ) -> GitState {
        var git = GitState(state: .init(known: state), checks: .init(known: checks), deployConfigured: false)
        git.mergeStateStatus = mergeStateStatus.map { .init(known: $0) }
        git.isDraft = isDraft
        git.noCi = noCi
        git.handoff = handoff.map { .init(known: $0) }
        git.reviewBlock = reviewBlock
        git.mergeable = mergeable
        git.headSha = headSha
        if let latestReview {
            git.latestReview = .init(state: .init(value1: .init(rawValue: latestReview), value2: latestReview),
                author: "r1", submittedAt: 0)
        }
        return git
    }

    static func verdict(
        headSha: String = "x", decision: ReviewDecisionKnown = .changesRequested,
        dismissed: Bool = false, findings: [String] = ["fix it"], addressRound: Int = 1,
        finalRoundPending: Bool = false, updatedAt: Int = 0
    ) -> ReviewVerdict {
        ReviewVerdict(sessionId: "s1", headSha: headSha, decision: .init(known: decision),
            summary: "review", body: "review", findings: findings, addressRound: addressRound,
            addressCap: 3, finalRoundPending: finalRoundPending, finalRoundTimeoutMs: 900_000,
            dismissed: dismissed, updatedAt: updatedAt)
    }
}
