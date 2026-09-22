import Testing
import ShepherdKit

@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
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

    // MARK: - The Request Review gate

    // MARK: - A late answer belongs to the session it was asked for

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
}
