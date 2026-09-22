import ShepherdKit
import SwiftUI

/// When an action is offered and when it is refused — the native reading of GitRail's
/// `mergeBlocked` and `ciLabel`. Pure functions, so the rules are tested without hosting a view
/// (the pattern `SessionStatusStyle` uses).
public enum GitPanelRules {
    /// Every open enum is read through `known`: a value this build has never heard of must not
    /// silently disable the operator's merge button, so an unknown merge state is NOT blocking.
    public static func mergeBlocked(_ git: GitState, busy: Bool) -> Bool {
        if busy { return true }
        guard git.state.known == .open else { return true }
        if git.isDraft == true { return true }
        if git.checks.known == .failure { return true }
        switch git.mergeStateStatus?.known {
        case .blocked, .behind, .dirty: return true
        default: return false
        }
    }

    /// The four states this build knows, and the wire value for anything newer — a label the
    /// operator can at least read and report, rather than a silent "no CI".
    public static func ciLabel(_ git: GitState) -> String {
        switch git.checks.known {
        case .success: L.t("gitrail_ci_passing")
        case .pending: L.t("gitrail_ci_pending")
        case .failure: L.t("gitrail_ci_failing")
        // Spelled out: `known` is an Optional, so a bare `.none` here would match `nil` — the
        // "a status this build does not know" branch — and never the wire value "none".
        case .some(ChecksStateKnown.none): L.t("gitrail_ci_none")
        case nil: git.checks.rawValue
        }
    }

    public static func ciTint(_ git: GitState) -> Color {
        switch git.checks.known {
        case .success: .green
        case .pending: .orange
        case .failure: .red
        default: .secondary
        }
    }

    /// GitHub only, and only for an open PR that has a number to request a review on.
    public static func canRequestReview(_ git: GitState) -> Bool {
        git.kind?.known == .github && git.state.known == .open && git.number != nil
    }

    /// Who may still be asked: the author cannot review their own PR, and a reviewer already
    /// requested is not offered again — the filter the web popover applies. `unavailable` is the
    /// server saying it could not list collaborators at all, which offers nobody rather than
    /// quietly falling back to a partial list.
    public static func reviewCandidates(_ options: PrReviewerOptions) -> [String] {
        guard !options.unavailable else { return [] }
        return options.logins.filter {
            $0 != options.authorLogin && !options.requestedReviewers.contains($0)
        }
    }

    /// Whether the Request Review button is refused.
    ///
    /// The draft check reads the **fresh** `GitState`, never the cached
    /// `PrReviewerOptions.isDraft` the reviewer listing was loaded with. "Set ready for review"
    /// re-reads git but not the reviewer options, and the review box's `.task(id:)` key does not
    /// change either — so gating on the snapshot left the button disabled with no way back
    /// inside the tab, and the inverse ("mark draft", then click) sent a request the server
    /// answers 409 `review_request_draft`.
    public static func reviewRequestBlocked(_ git: GitState, chosen: String?, busy: Bool) -> Bool {
        if busy { return true }
        if chosen == nil { return true }
        return git.isDraft == true
    }

    /// Whether a late answer still belongs on screen: the model must still belong to the active
    /// store AND the panel must still be showing the session the read was made for.
    ///
    /// `SessionDetailView` hosts the tabs in a `TabView` with no `.id(session.id)`, so the view
    /// identity — and its `@State` — survives a session switch. `model.isActive` alone therefore
    /// let an in-flight reviewer read for session A overwrite session B's picker, offering the
    /// operator logins from another repo's PR; the same gap let A's merge failure surface as a
    /// notice under B.
    public static func acceptsAnswer(modelIsActive: Bool, requested: String, showing: String?) -> Bool {
        modelIsActive && requested == showing
    }

    /// The reviewer the picker starts on: the server's own suggestion when it is still a
    /// candidate, otherwise the first one.
    public static func preselectedReviewer(_ options: PrReviewerOptions) -> String? {
        let candidates = reviewCandidates(options)
        if let suggested = options.defaultReviewer, candidates.contains(suggested) {
            return suggested
        }
        return candidates.first
    }
}
