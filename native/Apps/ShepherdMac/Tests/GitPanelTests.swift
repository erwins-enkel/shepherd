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

    // MARK: - The Request Review gate

    /// "Set ready for review" re-reads git but NOT the reviewer options, and the review box's
    /// `.task(id:)` key does not change — so gating the button on the snapshot
    /// `PrReviewerOptions.isDraft` left it permanently disabled with no way back inside the tab.
    /// The fresh `GitState` is the authority.
    @Test func theReviewRequestGateFollowsTheFreshGitStateNotTheCachedOptions() {
        let stale = options(isDraft: true)  // loaded while the PR was still a draft
        // Marked ready since: the button must be offered again.
        #expect(
            GitPanelRules.reviewRequestBlocked(
                git(isDraft: false), chosen: "grace", busy: false) == false)
        // And the inverse: marked draft since, so the click that would 409 is refused up front.
        #expect(
            GitPanelRules.reviewRequestBlocked(git(isDraft: true), chosen: "grace", busy: false))
        #expect(stale.isDraft)  // the cached snapshot said otherwise in both directions
    }

    @Test func theReviewRequestGateAlsoRefusesABusyPanelAndAnEmptyPicker() {
        #expect(GitPanelRules.reviewRequestBlocked(git(), chosen: "grace", busy: true))
        #expect(GitPanelRules.reviewRequestBlocked(git(), chosen: nil, busy: false))
        #expect(GitPanelRules.reviewRequestBlocked(git(), chosen: "grace", busy: false) == false)
    }

    /// A forge that does not say whether the PR is a draft is not a draft.
    @Test func anAbsentDraftFlagDoesNotBlockTheRequest() {
        #expect(
            GitPanelRules.reviewRequestBlocked(
                git(isDraft: nil), chosen: "grace", busy: false) == false)
    }

    // MARK: - A late answer belongs to the session it was asked for

    /// `SessionDetailView` hosts the tabs in a `TabView` with no `.id(session.id)`, so the view
    /// identity and its `@State` survive a session switch: an in-flight reviewer read for
    /// session A would otherwise land in session B's picker, offering logins from another repo's
    /// PR. The same gap let A's merge failure surface as a notice under B.
    @Test func aLateAnswerIsOnlyAcceptedForTheSessionStillOnScreen() {
        #expect(GitPanelRules.acceptsAnswer(modelIsActive: true, requested: "a", showing: "a"))
        #expect(
            GitPanelRules.acceptsAnswer(modelIsActive: true, requested: "a", showing: "b")
                == false)
        #expect(
            GitPanelRules.acceptsAnswer(modelIsActive: true, requested: "a", showing: nil)
                == false)
        // A torn-down model is still refused whatever the session is.
        #expect(
            GitPanelRules.acceptsAnswer(modelIsActive: false, requested: "a", showing: "a")
                == false)
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
