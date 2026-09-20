import ShepherdKit
import SwiftUI

/// When an action is offered and when it is refused — the native reading of GitRail's
/// `mergeBlocked` and `ciLabel`. Pure functions, so the rules are tested without hosting a view
/// (the pattern `SessionStatusStyle` uses).
enum GitPanelRules {
    /// Every open enum is read through `known`: a value this build has never heard of must not
    /// silently disable the operator's merge button, so an unknown merge state is NOT blocking.
    static func mergeBlocked(_ git: GitState, busy: Bool) -> Bool {
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
    static func ciLabel(_ git: GitState) -> String {
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

    static func ciTint(_ git: GitState) -> Color {
        switch git.checks.known {
        case .success: .green
        case .pending: .orange
        case .failure: .red
        default: .secondary
        }
    }

    /// GitHub only, and only for an open PR that has a number to request a review on.
    static func canRequestReview(_ git: GitState) -> Bool {
        git.kind?.known == .github && git.state.known == .open && git.number != nil
    }

    /// Who may still be asked: the author cannot review their own PR, and a reviewer already
    /// requested is not offered again — the filter the web popover applies. `unavailable` is the
    /// server saying it could not list collaborators at all, which offers nobody rather than
    /// quietly falling back to a partial list.
    static func reviewCandidates(_ options: PrReviewerOptions) -> [String] {
        guard !options.unavailable else { return [] }
        return options.logins.filter {
            $0 != options.authorLogin && !options.requestedReviewers.contains($0)
        }
    }

    /// The reviewer the picker starts on: the server's own suggestion when it is still a
    /// candidate, otherwise the first one.
    static func preselectedReviewer(_ options: PrReviewerOptions) -> String? {
        let candidates = reviewCandidates(options)
        if let suggested = options.defaultReviewer, candidates.contains(suggested) {
            return suggested
        }
        return candidates.first
    }
}

/// PR status and the actions that change it — the native reading of `GitRail.svelte`.
///
/// Every action goes through `SessionCommandState` — the gate the toolbar's archive and
/// interrupt already use — so exactly one runs at a time, a failure lands in a `NoticeBar` in
/// the operator's language, and a completion for a store the operator has left touches nothing.
/// The two destructive actions are behind a confirmation dialog, like the archive flow.
///
/// The panel itself never polls: the contract declares `session:git`, and `DetailModel` reloads
/// from that push. `.task(id:)` still asks once, because the model does not replay a frame that
/// arrived before this tab was ever opened.
struct GitTabView: View {
    let session: Session
    let model: DetailModel
    let store: SessionStore
    @State private var command = SessionCommandState()
    @State private var confirmingMerge = false
    @State private var confirmingClose = false
    /// Starts at `.loading` rather than an idle case: the review box has its own `.task` that
    /// loads immediately, so "not asked yet" and "asking" look the same to the operator.
    @State private var reviewers: Loaded<PrReviewerOptions> = .loading
    @State private var chosenReviewer: String?

    private var state: Loaded<GitState?> { model.git[session.id] ?? .loading }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let message = command.message {
                NoticeBar(message: message) { command.clear() }
            }
            DetailStateView(state: phase, retry: reload) { content }
        }
        .accessibilityIdentifier("detail-tab-git")
        .toolbar {
            // An explicit id: four detail tabs each add a Refresh item, and SwiftUI matches
            // toolbar items by identity when one tab replaces another.
            ToolbarItem(id: "detail-git-refresh") {
                Button(L.t("native_detail_refresh"), systemImage: "arrow.clockwise", action: reload)
                    .labelStyle(.iconOnly)
                    .disabled(state.isLoading || model.isRefreshing(.git, session: session.id))
            }
        }
        .confirmationDialog(
            L.t("native_detail_merge_confirm_title"), isPresented: $confirmingMerge,
            titleVisibility: .visible
        ) {
            Button(L.t("native_detail_merge_confirm_action")) { merge() }
            Button(L.t("common_cancel"), role: .cancel) {}
        } message: {
            Text(verbatim: L.t("native_detail_merge_confirm_body"))
        }
        .confirmationDialog(
            L.t("native_detail_close_confirm_title"), isPresented: $confirmingClose,
            titleVisibility: .visible
        ) {
            Button(L.t("native_detail_close_confirm_action"), role: .destructive) { closePR() }
            Button(L.t("common_cancel"), role: .cancel) {}
        } message: {
            Text(verbatim: L.t("native_detail_close_confirm_body"))
        }
        .task(id: DetailTaskKey(session: session.id, model: model)) {
            command.clear()
            reviewers = .loading
            chosenReviewer = nil
            await model.poll(.git, session: session.id)
        }
    }

    private var phase: DetailStatePhase { Self.phase(for: state) }

    /// Lifted out of `body` so the mapping is assertable without hosting a view. A null
    /// `GitState` is "this repo has no forge, or no PR" — not an error.
    static func phase(for state: Loaded<GitState?>) -> DetailStatePhase {
        if state.failure != nil { return .failed(L.t("gitrail_status_failed")) }
        guard let value = state.value else { return .loading }
        return value == nil ? .empty(L.t("native_detail_git_none")) : .content
    }

    @ViewBuilder
    private var content: some View {
        if let git = state.value ?? nil {
            VStack(alignment: .leading, spacing: 16) {
                summary(git)
                actions(git)
                if GitPanelRules.canRequestReview(git) { reviewRequest(git) }
                Spacer()
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("detail-git-panel")
        }
    }

    private func summary(_ git: GitState) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                if let number = git.number {
                    Text(verbatim: "#\(number)").font(.title3.monospaced().weight(.semibold))
                }
                Text(verbatim: git.title ?? "").font(.title3).textSelection(.enabled)
                Spacer()
                Text(verbatim: GitPanelRules.ciLabel(git))
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(GitPanelRules.ciTint(git).opacity(0.18), in: Capsule())
                    .foregroundStyle(GitPanelRules.ciTint(git))
                    .accessibilityIdentifier("detail-git-ci")
            }
            HStack(spacing: 12) {
                // The raw wire value: `state` is an open enum and this line is diagnostic.
                Text(verbatim: git.state.rawValue).font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("detail-git-state")
                if let url = git.url, let link = URL(string: url) {
                    Link(url, destination: link).font(.caption)
                }
            }
            if let review = git.latestReview {
                Text(verbatim: "\(review.author) · \(review.state.rawValue)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func actions(_ git: GitState) -> some View {
        HStack(spacing: 10) {
            // `PrStateKnown.none` spelled out: `known` is an Optional, and a bare `.none`
            // would read as "a PR state this build does not know", not "no PR yet".
            if git.state.known == PrStateKnown.none {
                Button(L.t("gitrail_create_pr")) { openPR() }
                    .disabled(command.busy)
                    .accessibilityIdentifier("detail-git-open")
            }
            if git.state.known == .open {
                Button(L.t("gitrail_merge")) { confirmingMerge = true }
                    .disabled(GitPanelRules.mergeBlocked(git, busy: command.busy))
                    .accessibilityIdentifier("detail-git-merge")
                let draftLabel =
                    git.isDraft == true ? L.t("prbadge_mark_ready") : L.t("prbadge_mark_draft")
                Button(draftLabel) { toggleDraft(isDraft: git.isDraft == true) }
                    .disabled(command.busy)
                    .accessibilityIdentifier("detail-git-draft")
                Button(L.t("native_detail_close_confirm_action"), role: .destructive) {
                    confirmingClose = true
                }
                .disabled(command.busy)
                .accessibilityIdentifier("detail-git-close")
            }
            if command.busy { ProgressView().controlSize(.small) }
            Spacer()
        }
    }

    @ViewBuilder
    private func reviewRequest(_ git: GitState) -> some View {
        GroupBox(L.t("prreview_title")) {
            HStack(spacing: 10) {
                switch reviewers {
                case .loading:
                    Text(verbatim: L.t("prreview_loading")).foregroundStyle(.secondary)
                case .failed:
                    Text(verbatim: L.t("prreview_load_failed")).foregroundStyle(.secondary)
                    Button(L.t("common_retry")) { loadReviewers() }
                case .ready(let options):
                    let candidates = GitPanelRules.reviewCandidates(options)
                    if candidates.isEmpty {
                        Text(verbatim: L.t("prreview_no_candidates")).foregroundStyle(.secondary)
                    } else {
                        Picker(L.t("native_detail_reviewer_label"), selection: $chosenReviewer) {
                            ForEach(candidates, id: \.self) { login in
                                Text(verbatim: login).tag(String?.some(login))
                            }
                        }
                        .frame(maxWidth: 260)
                        .accessibilityIdentifier("detail-git-reviewer")
                        Button(L.t("prreview_title")) {
                            if let login = chosenReviewer, let number = git.number {
                                requestReview(number: number, login: login)
                            }
                        }
                        .disabled(command.busy || chosenReviewer == nil || options.isDraft)
                        .accessibilityIdentifier("detail-git-request-review")
                    }
                }
                Spacer()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: DetailTaskKey(session: session.id, model: model)) { loadReviewers() }
    }

    // MARK: - Commands

    /// True while the model this view was built for still belongs to the active store. Every
    /// result is dropped when it does not: a merge that lands after a profile switch must not
    /// write a notice about a server the operator has left. `DetailModel.teardown()` is the
    /// signal — `AppModel` calls it immediately before it lets the store go.
    private func isCurrent() -> Bool { model.isActive }

    /// Runs one PR action behind the shared gate, then re-reads git so the panel shows what the
    /// server now believes rather than what the action returned. `onSuccess` runs after that
    /// re-read and only when the command both succeeded and is still current.
    private func run(
        _ body: @escaping @MainActor () async throws -> Void,
        onSuccess: @escaping @MainActor () -> Void = {}
    ) {
        Task {
            let ok = await command.run(
                body,
                failureCopy: { L.t("native_detail_action_failed", $0) },
                isCurrent: isCurrent)
            guard ok else { return }
            await model.refreshGit(session: session.id)
            onSuccess()
        }
    }

    private func openPR() {
        run { _ = try await store.client.openPR(sessionID: session.id, title: nil, body: nil) }
    }

    private func merge() {
        run {
            _ = try await store.client.mergePR(
                sessionID: session.id, method: nil, deleteBranch: nil)
        }
    }

    private func toggleDraft(isDraft: Bool) {
        run {
            _ =
                isDraft
                ? try await store.client.markPRReady(sessionID: session.id)
                : try await store.client.markPRDraft(sessionID: session.id)
        }
    }

    private func closePR() {
        run { _ = try await store.client.closePR(sessionID: session.id) }
    }

    /// The reviewer list is re-read alongside git: requesting a review changes who is still a
    /// candidate, and `run` only refreshes the PR itself.
    private func requestReview(number: Int, login: String) {
        run {
            _ = try await store.client.requestPRReview(
                sessionID: session.id, prNumber: number, reviewer: login)
        } onSuccess: {
            loadReviewers()
        }
    }

    private func loadReviewers() {
        reviewers = .loading
        Task {
            do {
                let options = try await store.client.reviewers(sessionID: session.id)
                guard isCurrent() else { return }
                reviewers = .ready(options)
                chosenReviewer = GitPanelRules.preselectedReviewer(options)
            } catch {
                guard isCurrent() else { return }
                reviewers = .failed(ShepherdErrorCopy.message(error))
            }
        }
    }

    private func reload() { Task { await model.load(.git, session: session.id) } }
}
