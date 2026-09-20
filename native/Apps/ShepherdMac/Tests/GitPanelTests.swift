import Testing
import ShepherdKit

@testable import Shepherd

/// The PR tab's rules, asserted without hosting a view — the pattern
/// `SessionStatusStyleTests` and `UnifiedPatchTests` already use.
@MainActor
struct GitPanelTests {
    private func git(
        state: PrStateKnown = .open,
        checks: ChecksStateKnown = .success,
        mergeState: MergeStateStatusKnown? = .clean,
        isDraft: Bool? = false,
        kind: ForgeKindKnown? = .github,
        number: Int? = 12
    ) -> GitState {
        GitState(
            kind: kind.map { .init(known: $0) },
            state: .init(known: state),
            number: number,
            checks: .init(known: checks),
            mergeStateStatus: mergeState.map { .init(known: $0) },
            isDraft: isDraft,
            deployConfigured: false)
    }

    @Test func aCleanOpenPrCanBeMergedAndBusyBlocksIt() {
        #expect(GitPanelRules.mergeBlocked(git(), busy: false) == false)
        #expect(GitPanelRules.mergeBlocked(git(), busy: true))
    }

    @Test func aDraftFailingOrBlockedPrCannotBeMerged() {
        #expect(GitPanelRules.mergeBlocked(git(isDraft: true), busy: false))
        #expect(GitPanelRules.mergeBlocked(git(checks: .failure), busy: false))
        #expect(GitPanelRules.mergeBlocked(git(mergeState: .blocked), busy: false))
        #expect(GitPanelRules.mergeBlocked(git(mergeState: .behind), busy: false))
        #expect(GitPanelRules.mergeBlocked(git(mergeState: .dirty), busy: false))
    }

    @Test func aPrThatIsNotOpenCannotBeMerged() {
        #expect(GitPanelRules.mergeBlocked(git(state: .merged), busy: false))
        #expect(GitPanelRules.mergeBlocked(git(state: .none), busy: false))
    }

    @Test func aMergeStateThisBuildDoesNotKnowIsNotTreatedAsBlocking() {
        var unknown = git()
        unknown.mergeStateStatus = .init(unknown: "quiescing")
        #expect(GitPanelRules.mergeBlocked(unknown, busy: false) == false)
    }

    /// A missing `mergeStateStatus` is the forge not saying, not the forge refusing.
    @Test func anAbsentMergeStateIsNotTreatedAsBlocking() {
        #expect(GitPanelRules.mergeBlocked(git(mergeState: nil), busy: false) == false)
    }

    @Test func theCiLabelFollowsTheChecksState() {
        #expect(GitPanelRules.ciLabel(git(checks: .success)) == L.t("gitrail_ci_passing"))
        #expect(GitPanelRules.ciLabel(git(checks: .pending)) == L.t("gitrail_ci_pending"))
        #expect(GitPanelRules.ciLabel(git(checks: .failure)) == L.t("gitrail_ci_failing"))
        #expect(GitPanelRules.ciLabel(git(checks: .none)) == L.t("gitrail_ci_none"))
    }

    /// A checks state this build has never heard of shows the wire value rather than
    /// silently reading as "no CI".
    @Test func anUnknownChecksStateShowsItsWireValue() {
        var unknown = git()
        unknown.checks = .init(unknown: "queued")
        #expect(GitPanelRules.ciLabel(unknown) == "queued")
    }

    @Test func onlyAnOpenGithubPrWithANumberCanRequestAReview() {
        #expect(GitPanelRules.canRequestReview(git()))
        #expect(GitPanelRules.canRequestReview(git(kind: .local)) == false)
        #expect(GitPanelRules.canRequestReview(git(number: nil)) == false)
        #expect(GitPanelRules.canRequestReview(git(state: .closed)) == false)
    }

    // MARK: - Reviewer candidates

    private func options(
        logins: [String] = ["ada", "grace", "lin"],
        unavailable: Bool = false,
        requested: [String] = [],
        author: String? = "ada",
        defaultReviewer: String? = nil,
        isDraft: Bool = false
    ) -> PrReviewerOptions {
        PrReviewerOptions(
            logins: logins, unavailable: unavailable, prNumber: 12, isFork: false,
            requestedReviewers: requested, authorLogin: author,
            defaultReviewer: defaultReviewer, isDraft: isDraft)
    }

    @Test func theAuthorAndAlreadyRequestedReviewersAreNotOffered() {
        #expect(GitPanelRules.reviewCandidates(options()) == ["grace", "lin"])
        #expect(GitPanelRules.reviewCandidates(options(requested: ["grace"])) == ["lin"])
    }

    /// `unavailable` is the server saying it could not list collaborators at all — an empty
    /// offer, not a silent full list.
    @Test func anUnavailableListingOffersNobody() {
        #expect(GitPanelRules.reviewCandidates(options(unavailable: true)).isEmpty)
    }

    @Test func theDefaultReviewerIsPreselectedWhenItIsStillACandidate() {
        #expect(GitPanelRules.preselectedReviewer(options(defaultReviewer: "lin")) == "lin")
        // The author is never a candidate, so a default naming them falls back to the first.
        #expect(GitPanelRules.preselectedReviewer(options(defaultReviewer: "ada")) == "grace")
        #expect(GitPanelRules.preselectedReviewer(options()) == "grace")
        #expect(GitPanelRules.preselectedReviewer(options(logins: ["ada"])) == nil)
    }

    // MARK: - Phase

    @Test func aNullGitStateReadsAsEmptyRatherThanAnError() {
        #expect(GitTabView.phase(for: .ready(nil)) == .empty(L.t("native_detail_git_none")))
    }

    @Test func thePhaseFollowsTheLoadedValue() {
        #expect(GitTabView.phase(for: .loading) == .loading)
        #expect(GitTabView.phase(for: .failed("boom")) == .failed(L.t("gitrail_status_failed")))
        #expect(GitTabView.phase(for: .ready(git())) == .content)
    }
}
