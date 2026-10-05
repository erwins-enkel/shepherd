import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit

/// One activation owns the commands shared by list and detail. No additional event
/// connection: action availability and recaps come from ActionsModel.
@MainActor
final class IOSSessionActions: AppExtension {
    private var states: [String: IOSSessionActionState] = [:]
    private weak var app: AppModel?
    private var store: SessionStore?
    private let generation: Int
    private var pruneWatcher: Task<Void, Never>?
    private var pruneSignal: AsyncStream<Void>.Continuation?
    var cachedSessionIDs: Set<String> { Set(states.keys) }

    init(store: SessionStore, app: AppModel) {
        self.store = store
        self.app = app
        generation = app.activationGeneration
        let (changes, signal) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        pruneSignal = signal
        pruneWatcher = Task { [weak self, weak store, weak app] in
            var iterator = changes.makeAsyncIterator()
            while !Task.isCancelled {
                guard let self, let store, let app else { return }
                let retained = withObservationTracking {
                    var ids = Set(store.sessions.map(\.id))
                    if let selected = app.selectedSessionID { ids.insert(selected) }
                    // An archiving relaunch can remove its source before returning
                    // the replacement. Wake again when that command completes.
                    for (id, state) in self.states where state.busy { ids.insert(id) }
                    return ids
                } onChange: { signal.yield(()) }
                self.reconcile(keeping: retained)
                guard await iterator.next() != nil else { return }
            }
        }
    }

    func state(for session: Session) -> IOSSessionActionState {
        if let state = states[session.id] { return state }
        guard let store, let app, let actions = app.extension(ActionsModel.self),
              let merge = app.extension(MergeModel.self) else { preconditionFailure("Actions must be installed before presentation") }
        let id = session.id, generation = generation
        let state = IOSSessionActionState(operations: .live(store), merge: merge,
            session: { [weak store] in store?.session(id: id) },
            actions: { [weak actions] in actions?.actions(for: $0) ?? [] },
            git: { [weak app] in
                guard let app else { return nil }
                return MergeInputs.git(app)[id]
            },
            canWrite: { [weak app, weak store] in
                guard let app, let store else { return false }
                return app.store === store && app.activationGeneration == generation
                    && app.allowsTerminalInput && app.liveRequestAudit == nil
            },
            isSelected: { [weak app] in app?.selectedSessionID == id },
            isReviewing: { [weak app] in
                guard let app else { return true }
                return MergeInputs.reviewing(app, id)
            },
            canSelectReplacement: { [weak app, weak store] in
                app?.selectedSessionID == id || (app?.selectedSessionID == nil && store?.session(id: id) == nil)
            },
            resumeSucceeded: { [weak app] id in
                app?.extension(IOSTerminalController.self)?.resumeSucceeded(sessionID: id)
            },
            decommissioned: { [weak app] _ in app?.selectedSessionID = nil },
            selectReplacement: { [weak app, weak actions] result, note in
                actions?.recordOutcomeNote(note.text, forSessionID: result.id)
                app?.selectedSessionID = result.id
            })
        states[id] = state
        pruneSignal?.yield(())
        return state
    }

    private func reconcile(keeping ids: Set<String>) {
        for id in states.keys.filter({ !ids.contains($0) }) {
            states.removeValue(forKey: id)?.invalidate()
        }
    }

    func teardown() {
        pruneSignal?.finish(); pruneSignal = nil
        pruneWatcher?.cancel(); pruneWatcher = nil
        states.values.forEach { $0.invalidate() }
        states.removeAll()
        store = nil
        app = nil
    }
}

/// Injected commands use the same Kit wrappers as Mac. Tests cross this seam
/// without launching a server or writing to the operator's sessions.
@MainActor
struct IOSActionOperations {
    var stop: (String) async throws -> Void
    var resume: (String) async throws -> Void
    var ready: (String, Bool) async throws -> Void
    var rename: (String, String) async throws -> RenameResult
    var amend: (String, String, Bool) async throws -> AmendmentCreated
    var relaunch: (String, RelaunchRequest) async throws -> RelaunchResult
    var recap: (String) async throws -> RecapRegenerateResult
    var git: (String) async throws -> GitState?
    var merge: (String, MergeMethod?, Bool, Components.Schemas.MergeConfirmation) async throws -> GitState
    var leftovers: (String) async throws -> ComposeLeftovers
    var closePR: (String) async throws -> GitState
    var archive: (String, [String]?) async throws -> Void

    static func live(_ store: SessionStore) -> Self {
        let client = store.client
        return .init(stop: { try await store.interrupt(id: $0) },
            resume: { _ = try await client.resume(sessionID: $0) },
            ready: { try await client.setReadyToMerge(sessionID: $0, ready: $1) },
            rename: { try await client.rename(sessionID: $0, name: $1) },
            amend: { try await client.amend(sessionID: $0, text: $1, steer: $2) },
            relaunch: { try await client.relaunch(sessionID: $0, overrides: $1) },
            recap: { try await client.regenerateRecap(sessionID: $0) },
            git: { try await client.git(sessionID: $0) },
            merge: { try await client.mergePR(sessionID: $0, method: $1, deleteBranch: $2, confirm: $3) },
            leftovers: { try await client.sessionLeftovers(id: $0) },
            closePR: { try await client.closePR(sessionID: $0) },
            archive: { try await store.archive(id: $0, reap: $1) })
    }
}

/// What the PR choice in the decommission sheet does before the session is archived.
enum IOSDecommissionChoice: String, Identifiable {
    case keep, merge, close
    var id: String { rawValue }
}

/// The decommission sheet's facts, read fresh when it opens: what the session still runs, and
/// the PR as the server sees it now — the merge choice confirms exactly that revision.
struct IOSDecommissionDraft {
    var loaded = false
    var leftovers: [Components.Schemas.ComposeLeftover] = []
    var probesUnavailable = false
    var reap: Set<String> = []
    var git: GitState?
    /// The PR step already ran, so a retry after a failed archive only archives.
    var prSettled = false

    var asksAboutPR: Bool { !prSettled && git?.state.known == .open && git?.number != nil }
    /// `DecommissionPrDialog.svelte`: keep and close always, merge only where the forge can.
    var choices: [IOSDecommissionChoice] {
        guard asksAboutPR else { return [.keep] }
        return MergeConfirmationRules.mergeAvailable(git) ? [.keep, .merge, .close] : [.keep, .close]
    }
}

@Observable
@MainActor
final class IOSSessionActionState {
    enum Sheet: String, Identifiable { case rename, amend, relaunch, merge, decommission; var id: String { rawValue } }
    let command = SessionCommandState()
    let outcome = ActionBarOutcome()
    let mergeModel: MergeModel
    var sheet: Sheet?
    var name = ""
    var amendment = ""
    var steer = true
    var repo = ""
    var branch = ""
    var prompt = ""
    var method: MergeMethod?
    var deleteBranch = true
    var decommission = IOSDecommissionDraft()
    private(set) var candidate: GitState?
    private(set) var presentedAt: Date?
    private var presentationRevision = 0
    private var invalidated = false
    private var mergeBusy = false
    private var mergeError: String?
    private let operations: IOSActionOperations
    private let readSession: () -> Session?
    private let readActions: (Session) -> [SessionAction]
    private let readGit: () -> GitState?
    private let canWrite: () -> Bool
    private let isSelected: () -> Bool
    private let isReviewing: () -> Bool
    private let canSelectReplacement: () -> Bool
    private let selectReplacement: (Session, ActionNote) -> Void
    private let resumeSucceeded: (String) -> Void
    private let decommissioned: (String) -> Void

    init(operations: IOSActionOperations, merge: MergeModel, session: @escaping () -> Session?,
         actions: @escaping (Session) -> [SessionAction], git: @escaping () -> GitState? = { nil },
         canWrite: @escaping () -> Bool,
         isSelected: @escaping () -> Bool, isReviewing: @escaping () -> Bool = { false },
         canSelectReplacement: @escaping () -> Bool,
         resumeSucceeded: @escaping (String) -> Void = { _ in },
         decommissioned: @escaping (String) -> Void = { _ in },
         selectReplacement: @escaping (Session, ActionNote) -> Void) {
        self.operations = operations; mergeModel = merge; readSession = session
        readActions = actions; readGit = git; self.canWrite = canWrite; self.isSelected = isSelected
        self.resumeSucceeded = resumeSucceeded; self.decommissioned = decommissioned
        self.isReviewing = isReviewing; self.canSelectReplacement = canSelectReplacement; self.selectReplacement = selectReplacement
    }

    var allowsWrites: Bool { !invalidated && canWrite() }
    var busy: Bool { command.busy || mergeBusy }
    var actions: [SessionAction] {
        guard let session = readSession() else { return [] }
        // The core's settled-session gate is shared; iOS also has the full Herd
        // git cache, so honor the web rail's open-PR-or-already-ready predicate.
        return readActions(session).filter {
            $0 != .toggleReady || session.readyToMerge || readGit()?.state.known == .open
        }
    }
    var swipeActions: [SessionAction] { Self.swipeActions(from: actions) }
    static func swipeActions(from actions: [SessionAction]) -> [SessionAction] {
        [.stop, .resume, .toggleReady].filter { actions.contains($0) }
    }
    var error: String? { command.message ?? mergeError }

    static func label(_ action: SessionAction, session: Session) -> String {
        if action == .toggleReady {
            return L.t(session.readyToMerge ? "native_ios_actions_not_ready" : "native_ios_actions_ready")
        }
        return action.label(for: session)
    }

    func present(_ action: SessionAction) {
        guard allowsWrites, !busy, isSelected(), let session = readSession(), actions.contains(action) else { return }
        command.clear(); mergeError = nil; outcome.note = nil
        presentationRevision &+= 1
        switch action {
        case .rename: name = session.name; sheet = .rename
        case .amend: amendment = ""; steer = true; sheet = .amend
        case .relaunch:
            repo = session.repoPath; branch = session.baseBranch; prompt = session.prompt; sheet = .relaunch
        default: break
        }
    }

    func dismiss() {
        guard !busy else { return }
        presentationRevision &+= 1
        sheet = nil; candidate = nil; presentedAt = nil; decommission = IOSDecommissionDraft()
    }

    func detailDidDisappear() {
        // Preserve only an archiving relaunch's own nil-selection footprint.
        // Explicit navigation revokes the presentation even if a write is in flight.
        if !isSelected(), !canSelectReplacement() {
            presentationRevision &+= 1
            sheet = nil; candidate = nil; presentedAt = nil; decommission = IOSDecommissionDraft()
        } else if !busy { dismiss() }
    }

    func invalidate() {
        invalidated = true; presentationRevision &+= 1
        sheet = nil; candidate = nil; presentedAt = nil; outcome.note = nil; command.clear()
        decommission = IOSDecommissionDraft()
        mergeBusy = false; mergeError = nil
    }

    /// Inline writes stay on their own session even if the operator opens another
    /// card. Sheet completions additionally require the same selection/presentation.
    func execute(_ action: SessionAction) async {
        guard allowsWrites, !busy, let session = readSession(), actions.contains(action) else { return }
        mergeError = nil; outcome.note = nil
        let current = { self.allowsWrites && self.readSession()?.id == session.id }
        switch action {
        case .stop:
            let ok = await command.run({ try await operations.stop(session.id) },
                failureCopy: { _ in L.t("cardmenu_stop_failed", session.name) }, isCurrent: current)
            if ok { outcome.note = .success(L.t("cardmenu_stop_toast", session.name)) }
        case .resume, .toggleReady, .regenerateRecap:
            await outcome.run(action, session: session, command: command, operation: {
                switch action {
                case .resume: try await operations.resume(session.id)
                case .toggleReady: try await operations.ready(session.id, !session.readyToMerge)
                case .regenerateRecap:
                    let result = try await operations.recap(session.id)
                    guard result.ok, result.status.known != .error else {
                        throw ShepherdError.badRequest(L.t("recap_regenerate_failed"))
                    }
                default: break
                }
            }, failureCopy: { raw in
                switch action {
                case .resume: L.t("cardmenu_resume_failed", session.name)
                case .regenerateRecap: L.t("recap_regenerate_failed")
                default: L.t("native_actions_failed", raw)
                }
            }, isCurrent: current)
            if action == .resume, current(), error == nil, outcome.note?.tone == .success {
                resumeSucceeded(session.id)
            }
        case .rename, .amend, .relaunch: break
        }
    }

    var canSubmit: Bool {
        guard allowsWrites, !busy, let session = readSession() else { return false }
        switch sheet {
        case .rename: return actions.contains(.rename) && RenameSubmission.validate(name, current: session.name)
        case .amend: return actions.contains(.amend) && AmendSubmission.validate(amendment)
        case .relaunch:
            return actions.contains(.relaunch) && !repo.isEmpty
                && !branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && prompt.utf16.count <= 8000
        case .merge, .decommission, nil: return false
        }
    }

    static func relaunchRequest(session: Session, repo: String, branch: String, prompt: String) -> RelaunchRequest {
        .init(repoPath: repo == session.repoPath ? nil : repo,
            baseBranch: branch == session.baseBranch ? nil : branch, prompt: prompt == session.prompt ? nil : prompt)
    }

    func submit() async {
        guard canSubmit, isSelected(), let session = readSession(), let sheet else { return }
        mergeError = nil
        let revision = presentationRevision
        let current = {
            self.allowsWrites && revision == self.presentationRevision && self.isSelected()
                && self.readSession()?.id == session.id
        }
        var note: ActionNote?
        var replacement: Session?
        var archived = false
        var thrown: (any Error)?
        let typedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let typedAmendment = amendment.trimmingCharacters(in: .whitespacesAndNewlines), alsoSteer = steer
        let overrides = Self.relaunchRequest(session: session, repo: repo, branch: branch, prompt: prompt)
        let ok = await command.run({
            do {
                switch sheet {
                case .rename:
                    note = .success(RenameSubmission.note(for: try await operations.rename(session.id, typedName)))
                case .amend:
                    let result = try await operations.amend(session.id, typedAmendment, alsoSteer)
                    note = .success(alsoSteer ? AmendSubmission.note(steered: result.steered) : L.t("amend_recorded"))
                case .relaunch:
                    let result = try await operations.relaunch(session.id, overrides)
                    archived = result.archived; replacement = result.session
                    note = result.archived ? .success(L.t("relaunch_done", result.session.desig))
                        : .warning(L.t("relaunch_archive_failed"))
                case .merge, .decommission: return
                }
            } catch { thrown = error; throw error }
        }, failureCopy: { raw in
            switch sheet {
            case .rename: RenameSubmission.failureCopy(raw)
            case .amend: L.t("amend_failed")
            case .relaunch: ActionErrorCopy.relaunchFailure(thrown, fallback: raw)
            case .merge, .decommission: raw
            }
        }, isCurrent: {
            if sheet == .relaunch, archived {
                return self.allowsWrites && revision == self.presentationRevision && self.canSelectReplacement()
            }
            return current()
        })
        guard ok, let note else { return }
        self.sheet = nil
        if archived, let replacement { selectReplacement(replacement, note) }
        else { outcome.note = note }
    }

    var canDecommission: Bool {
        allowsWrites && readSession().map { $0.status.known != .archived } == true
    }

    /// Opens the sheet at once, then fills it from a fresh probe of leftovers and the PR. A failed
    /// probe never blocks: no leftovers is shown as "cannot detect", a failed PR read falls back
    /// to the herd's cached snapshot.
    func presentDecommission() {
        guard canDecommission, !busy, isSelected(), let session = readSession() else { return }
        command.clear(); mergeError = nil; outcome.note = nil
        presentationRevision &+= 1
        candidate = nil; presentedAt = nil
        decommission = IOSDecommissionDraft()
        sheet = .decommission
        let revision = presentationRevision
        Task { [weak self] in await self?.loadDecommission(session.id, revision: revision) }
    }

    private func loadDecommission(_ id: String, revision: Int) async {
        async let listing = probeLeftovers(id)
        async let git = freshGit(id)
        let (found, fresh) = await (listing, git)
        guard decommissionIsCurrent(revision) else { return }
        decommission.leftovers = found?.leftovers ?? []
        decommission.probesUnavailable = found?.probesUnavailable ?? true
        decommission.git = fresh ?? readGit()
        decommission.loaded = true
        presentedAt = Date()
    }

    private func probeLeftovers(_ id: String) async -> ComposeLeftovers? { try? await operations.leftovers(id) }
    private func freshGit(_ id: String) async -> GitState? { try? await operations.git(id) }
    private func decommissionIsCurrent(_ revision: Int) -> Bool {
        allowsWrites && revision == presentationRevision && sheet == .decommission
    }

    func canConfirmDecommission(_ choice: IOSDecommissionChoice, now: Date = Date()) -> Bool {
        guard allowsWrites, !busy, isSelected(), sheet == .decommission, decommission.loaded,
              decommission.choices.contains(choice), readSession()?.status.known != .archived,
              let presentedAt, now.timeIntervalSince(presentedAt) >= 0.350 else { return false }
        return choice != .merge || !mergeModel.busy
    }

    /// `createDecommissionCommit` in `ui/src/lib/decommission-commit.ts`: the PR step first, then
    /// the archive. Once the PR step went through, a retry only archives.
    /// - Returns: whether the session was decommissioned.
    @discardableResult
    func confirmDecommission(_ choice: IOSDecommissionChoice, now: Date = Date()) async -> Bool {
        guard canConfirmDecommission(choice, now: now), let session = readSession() else { return false }
        let draft = decommission, revision = presentationRevision
        let reap = draft.reap.isEmpty ? nil : draft.reap.sorted()
        var mergeFailed = false
        // The archive removes the row, so currency is the presentation, not the session.
        let ok = await command.run({
            if !draft.prSettled {
                switch choice {
                case .close: _ = try await operations.closePR(session.id)
                case .merge:
                    guard let git = draft.git else { throw ShepherdError.cancelled }
                    do { _ = try await operations.merge(session.id, nil, true, MergeConfirmationRules.payload(git)) }
                    catch { mergeFailed = true; throw error }
                case .keep: break
                }
                if revision == presentationRevision { decommission.prSettled = true }
            }
            try await operations.archive(session.id, reap)
        }, failureCopy: { L.t("native_archive_failed", $0) },
        isCurrent: { self.allowsWrites && revision == self.presentationRevision })
        if ok {
            sheet = nil; presentedAt = nil; decommission = IOSDecommissionDraft()
            if isSelected() { decommissioned(session.id) }
            return true
        }
        if mergeFailed, decommissionIsCurrent(revision) {
            // A refused merge confirmation would be refused again: re-read the PR so a retry
            // carries the revision and responsibility the server reports now.
            decommission.loaded = false; presentedAt = nil
            let fresh = await freshGit(session.id)
            guard decommissionIsCurrent(revision) else { return false }
            decommission.git = fresh ?? readGit()
            decommission.loaded = true
            presentedAt = Date()
        }
        return false
    }

    func canMerge(_ session: Session, git: [String: GitState], reviewing: Bool) -> Bool {
        allowsWrites && session.status.known != .archived
            && !MergeRules.ready([session], git: git, reviewing: reviewing ? [session.id] : []).isEmpty
    }

    /// Always fetch a fresh stamped PR before presenting the confirmation.
    func prepareMerge() {
        guard allowsWrites, !busy, !mergeModel.busy, isSelected(), let session = readSession(), session.readyToMerge, !isReviewing(),
              session.status.known != .archived else { return }
        command.clear(); mergeError = nil; outcome.note = nil; candidate = nil; presentedAt = nil
        presentationRevision &+= 1
        let revision = presentationRevision
        performMerge(revision: revision, commit: { [weak self] (git: GitState?) in
            guard let self, self.allowsWrites, self.isSelected(), self.presentationRevision == revision else { return }
            guard self.readSession()?.readyToMerge == true, !self.isReviewing(),
                  let git, git.state.known == .open, git.number != nil else {
                self.outcome.note = .warning(L.t("native_merge_action_failed"))
                return
            }
            self.candidate = git
            self.method = nil
            self.deleteBranch = true
            self.presentedAt = Date()
            self.sheet = .merge
        }) {
            guard self.allowsWrites, self.isSelected(), self.presentationRevision == revision else { throw ShepherdError.cancelled }
            return try await self.operations.git(session.id)
        }
    }

    func canConfirmMerge(now: Date = Date()) -> Bool {
        guard allowsWrites, !busy, !mergeModel.busy, isSelected(), sheet == .merge, readSession()?.readyToMerge == true,
              !isReviewing(), readSession()?.status.known != .archived,
              let candidate, candidate.state.known == .open, candidate.number != nil,
              let presentedAt, now.timeIntervalSince(presentedAt) >= 0.350 else { return false }
        return candidate.mergeGate?.handoff == nil || candidate.mergeGate?.handoff?.known != nil
    }

    func confirmMerge(now: Date = Date()) {
        guard canConfirmMerge(now: now), let candidate, let session = readSession() else { return }
        let payload = MergeConfirmationRules.payload(candidate)
        let method = method, deleteBranch = deleteBranch, revision = presentationRevision
        presentedAt = nil // A confirmation is spent even when the server refuses it.
        performMerge(revision: revision, commit: { [weak self] _ in
            guard let self, self.allowsWrites, self.isSelected(), self.presentationRevision == revision else { return }
            self.sheet = nil; self.candidate = nil
            self.outcome.note = .success(L.t("prbadge_merged_toast", String(candidate.number ?? 0)))
        }, failure: { [weak self] in
            guard let self, self.presentationRevision == revision else { return }
            self.sheet = nil; self.candidate = nil
        }) {
            guard self.allowsWrites, self.isSelected(), self.presentationRevision == revision,
                  self.readSession()?.readyToMerge == true, !self.isReviewing() else { throw ShepherdError.cancelled }
            return try await self.operations.merge(session.id, method, deleteBranch, payload)
        }
    }

    /// MergeModel still serializes all merge work. Only this session owns its
    /// progress/refusal; background snapshot failures belong to the overview.
    private func performMerge<Value: Sendable>(
        revision: Int,
        commit: @escaping @MainActor (Value) -> Void,
        failure: @escaping @MainActor () -> Void = {},
        _ operation: @escaping @MainActor () async throws -> Value
    ) {
        guard !mergeModel.busy else { return }
        mergeBusy = true
        mergeModel.perform(commit: { [weak self] value in
            self?.mergeBusy = false
            commit(value)
        }, failure: { [weak self] in
            self?.mergeBusy = false
            failure()
        }) {
            do { return try await operation() }
            catch {
                if self.allowsWrites, self.isSelected(), self.presentationRevision == revision {
                    self.mergeError = ShepherdErrorCopy.message(error)
                }
                throw error
            }
        }
    }
}
