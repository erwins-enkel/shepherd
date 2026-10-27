import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit

/// The commands the PR surface sends, injected so tests cross the seam without a server.
@MainActor
struct IOSUpNextPrCommands {
    var merge: (UpNextPr, MergeMethod?, Bool, MergeConfirmation?) async throws -> Void
    var dependabotRebase: (UpNextPr) async throws -> Void
    /// The server's push-only fix session (`POST /api/up-next/pr-fix`).
    var fix: (UpNextPr) async throws -> Session
    /// The PR description, read on demand for the sheet.
    var body: (UpNextPr) async throws -> String
    var createSession: (CreateSessionRequest) async throws -> CreateOutcome
    /// The repo's default branch, for a PR the server sent without `baseRefName`.
    var defaultBranch: (String) async throws -> String?

    static func live(_ client: ShepherdClient) -> Self {
        .init(merge: { pr, method, deleteBranch, confirm in
            try await client.mergeBacklogPr(repo: pr.repoPath, number: pr.number, method: method,
                                            deleteBranch: deleteBranch, confirm: confirm)
        }, dependabotRebase: { pr in
            try await client.requestDependabotRebase(repo: pr.repoPath, number: pr.number)
        }, fix: { pr in
            try await client.startUpNextPrFix(repo: pr.repoPath, number: pr.number)
        }, body: { pr in
            try await client.upNextPrBody(repo: pr.repoPath, number: pr.number)
        }, createSession: { request in
            try await client.createSession(request, spawnID: UUID().uuidString)
        }, defaultBranch: { repo in try await client.branches(repoPath: repo)._default })
    }
}

/// The merge confirmation for one backlog PR: what the operator sees and, after a refused
/// takeover, what the retry echoes back. Mirrors `IOSSessionActionState`'s merge sheet.
struct IOSUpNextPrMergeDraft: Equatable {
    let pr: UpNextPr
    var method: MergeMethod?
    var deleteBranch = true
    /// Set by a 409 responsibility gate; the next confirm carries its values.
    var refusal: BacklogMergeRefusal?
    var presentedAt: Date?

    var isTakeover: Bool { refusal?.gate?.handoff != nil || refusal?.gate?.reviewBlockBy != nil }
    var confirmTitle: String { L.t(isTakeover ? "mergeconfirm_confirm_takeover" : "mergeconfirm_confirm") }
}

/// Sessions the PR sheet starts: a fix through the server's endpoint, a review like the composer.
enum IOSUpNextPrSessionKind: String { case fix, review }

/// One per activation: the merge confirmation and the busy/error gate, so a swipe merge and a sheet merge never overlap.
/// Up Next itself stays the server's: nothing here recomputes a band.
@Observable
@MainActor
final class IOSUpNextPrController: AppExtension {
    let command = SessionCommandState()
    private(set) var mergeDraft: IOSUpNextPrMergeDraft?
    var note: ActionNote?
    private var invalidated = false
    private var presentationRevision = 0
    @ObservationIgnored private var commands: IOSUpNextPrCommands
    /// Resolved on use: extensions install in registration order, so it may not exist yet at init.
    @ObservationIgnored private let readMergeModel: () -> MergeModel?
    private var mergeModel: MergeModel? { readMergeModel() }
    @ObservationIgnored private let canWrite: () -> Bool
    @ObservationIgnored private let refreshQueue: () async -> Void

    init(store: SessionStore, app: AppModel) {
        let generation = app.activationGeneration
        commands = .live(store.client)
        readMergeModel = { [weak app] in app?.extension(MergeModel.self) }
        canWrite = { [weak app, weak store] in
            guard let app, let store else { return false }
            return app.store === store && app.activationGeneration == generation
                && app.allowsTerminalInput && app.liveRequestAudit == nil
        }
        refreshQueue = { [weak app] in await app?.extension(QueuesModel.self)?.refresh(recomputeUpNext: false, readOnly: true) }
    }

    /// Test seam: no app, no store.
    init(commands: IOSUpNextPrCommands, merge: MergeModel? = nil, canWrite: @escaping () -> Bool = { true },
         refreshQueue: @escaping () async -> Void = {}) {
        self.commands = commands; readMergeModel = { merge }; self.canWrite = canWrite; self.refreshQueue = refreshQueue
    }

    func teardown() { invalidate() }

    func invalidate() {
        invalidated = true; presentationRevision &+= 1
        mergeDraft = nil; note = nil
        command.clear()
    }

    var allowsWrites: Bool { !invalidated && canWrite() }
    var busy: Bool { command.busy }
    var error: String? { command.message }
    func clearFeedback() { command.clear(); note = nil }

    // MARK: Merge

    /// The swipe action and the sheet's Merge both land here; nothing merges without it.
    func prepareMerge(_ pr: UpNextPr) {
        guard allowsWrites, !busy, mergeModel?.busy != true, UpNextPrPresentation.mergeLock(pr) == nil else { return }
        clearFeedback()
        presentationRevision &+= 1
        mergeDraft = .init(pr: pr, presentedAt: Date())
    }

    func setMergeMethod(_ method: MergeMethod?) { mergeDraft?.method = method }
    func setDeleteBranch(_ delete: Bool) { mergeDraft?.deleteBranch = delete }

    func dismissMerge() {
        guard !busy else { return }
        presentationRevision &+= 1
        mergeDraft = nil
    }

    /// The production arming delay matches the session merge sheet; the timestamp is also checked
    /// here, so a stale rendered enabled button cannot act.
    func canConfirmMerge(now: Date = Date()) -> Bool {
        guard allowsWrites, !busy, mergeModel?.busy != true, let draft = mergeDraft,
              UpNextPrPresentation.mergeLock(draft.pr) == nil,
              let presentedAt = draft.presentedAt, now.timeIntervalSince(presentedAt) >= 0.350 else { return false }
        return draft.refusal?.gate?.handoff == nil || draft.refusal?.gate?.handoff?.known != nil
    }

    /// - Returns: whether the PR merged; a refused takeover re-arms the sheet with the gate shown.
    @discardableResult
    func confirmMerge(now: Date = Date()) async -> Bool {
        guard canConfirmMerge(now: now), let draft = mergeDraft else { return false }
        mergeDraft?.presentedAt = nil // A confirmation is spent even when the server refuses it.
        let revision = presentationRevision
        let confirm = draft.refusal?.confirmation
        var refusal: BacklogMergeRefusal?
        let ok = await command.run({
            do { try await commands.merge(draft.pr, draft.method, draft.deleteBranch, confirm) }
            catch let gate as BacklogMergeRefusal { refusal = gate; throw gate }
        }, failureCopy: { refusal?.message ?? $0 },
           isCurrent: { self.allowsWrites && revision == self.presentationRevision })
        guard revision == presentationRevision else { return false }
        if ok {
            mergeDraft = nil
            note = .success(L.t("prbadge_merged_toast", String(draft.pr.number)))
            await refreshQueue()
            await mergeModel?.refresh()
            return true
        }
        // A responsibility gate names who is responsible now; the retry echoes exactly that. Any
        // failure re-arms the sheet (another 350 ms) so the operator can retry or cancel.
        if let refusal { mergeDraft?.refusal = refusal }
        if mergeDraft != nil { mergeDraft?.presentedAt = Date() }
        return false
    }

    // MARK: Dependabot

    @discardableResult
    func requestRebase(_ pr: UpNextPr) async -> Bool {
        guard allowsWrites, !busy else { return false }
        clearFeedback()
        let revision = presentationRevision
        let ok = await command.run({ try await commands.dependabotRebase(pr) }, failureCopy: { $0 },
                                   isCurrent: { self.allowsWrites && revision == self.presentationRevision })
        if ok { note = .success(L.t("native_ios_upnext_pr_rebase_requested", String(pr.number))) }
        return ok
    }

    /// The confirmed train: one session that lands the plan's PRs in order, like the web's.
    @discardableResult
    func startTrain(_ plan: UpNextMergeTrainPlan, select: @escaping (String) -> Void) async -> Bool {
        await create(repo: plan.repoPath, base: plan.prs.first?.baseRefName, select: select) {
            UpNextPrPresentation.trainRequest(plan, baseBranch: $0)
        }
    }

    // MARK: Sessions

    /// A fix runs through the server's push-only repair session, as on the web; a review session
    /// is created like the composer's on the PR's base branch. Either way the new session is selected.
    @discardableResult
    func startSession(_ kind: IOSUpNextPrSessionKind, _ pr: UpNextPr, select: @escaping (String) -> Void) async -> Bool {
        switch kind {
        case .fix: await startFix(pr, select: select)
        case .review:
            await create(repo: pr.repoPath, base: pr.baseRefName, select: select) {
                UpNextPrPresentation.reviewRequest(pr, baseBranch: $0)
            }
        }
    }

    private func startFix(_ pr: UpNextPr, select: @escaping (String) -> Void) async -> Bool {
        guard allowsWrites, !busy, pr.action == .fix else { return false }
        clearFeedback()
        let revision = presentationRevision
        var session: Session?
        var failure: (any Error)?
        let ok = await command.run({
            do { session = try await commands.fix(pr) } catch { failure = error; throw error }
        }, failureCopy: { _ in failure.flatMap { Self.fixFailure($0, number: pr.number) } ?? L.t("upnext_pr_fix_failed", String(pr.number)) },
           isCurrent: { self.allowsWrites && revision == self.presentationRevision })
        guard ok, let session else { return false }
        note = .success(L.t("upnext_pr_fix_started", String(pr.number)))
        select(session.id)
        await refreshQueue()
        return true
    }

    /// The web's `fixFailure`: a fork's head and a PR a session already holds get their own line.
    static func fixFailure(_ error: any Error, number: Int) -> String? {
        switch error as? ShepherdError {
        case .unprocessable: L.t("upnext_pr_fix_fork", String(number))
        case .conflict(let code, _) where code == "pr_in_flight": L.t("upnext_pr_fix_in_flight", String(number))
        default: nil
        }
    }

    /// The sheet's description; nil when it could not be read.
    func loadBody(_ pr: UpNextPr) async -> String? { try? await commands.body(pr) }

    private func create(repo: String, base: String?, select: @escaping (String) -> Void,
                        request: @escaping (String) -> CreateSessionRequest) async -> Bool {
        guard allowsWrites, !busy else { return false }
        clearFeedback()
        let revision = presentationRevision
        var outcome: CreateOutcome?
        let ok = await command.run({
            var branch = base
            if branch == nil { branch = try await commands.defaultBranch(repo) }
            // The lookup may outlive the activation; nothing is posted through a stale client.
            guard allowsWrites, revision == presentationRevision else { throw ShepherdError.cancelled }
            outcome = try await commands.createSession(request(branch ?? "main"))
        }, failureCopy: { $0 }, isCurrent: { self.allowsWrites && revision == self.presentationRevision })
        guard ok, let outcome else { return false }
        switch outcome {
        case .created(let session):
            note = .success(L.t("native_ios_upnext_pr_started", session.desig))
            select(session.id)
        case .held: note = .warning(L.t("native_ios_upnext_pr_held"))
        }
        return true
    }
}
