import Foundation
import Observation
import ShepherdKit

/// One create attempt's transport: the spawn correlation id and, while the machine choice is
/// available (#2776), the Idempotency-Key that makes the task start at most once.
public struct CreateCall: Equatable, Sendable {
    public let spawnID: String
    public let idempotencyKey: String?
}

/// Presentation-owned create. A cancellation request never cancels the HTTP response: it may
/// report that the agent won the race. Only that response can settle the submission.
@Observable @MainActor
public final class ComposeSubmission {
    public init() {}

    public private(set) var busy = false
    public private(set) var slow = false
    public private(set) var canceling = false
    public private(set) var cancelRequested = false
    private(set) var spawnID: String?
    public private(set) var progress: Components.Schemas.SpawnProgressEvent?
    public private(set) var message: String?
    public private(set) var recoveryFailure: BackendFailure?
    /// The machine the attempt in flight goes to when it does not start on this server (#2776).
    public private(set) var sendingTo: SessionHost?
    /// The machine the last create waits for or is held on (#2776); nil after a hold here.
    public private(set) var heldOn: SessionHost?
    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    @ObservationIgnored private var timer: Task<Void, Never>?
    private var generation = 0
    private var stopped = false

    public static func phaseCopy(_ phase: Components.Schemas.SpawnPhase) -> String {
        switch phase.known {
        case .base: L.t("newtask_spawn_phase_base")
        case .worktree: L.t("newtask_spawn_phase_worktree")
        case .prompt: L.t("newtask_spawn_phase_prompt")
        case .launch: L.t("newtask_spawn_phase_launch")
        case .agent: L.t("newtask_spawn_phase_agent")
        case nil: L.t("newtask_spawning")
        }
    }

    func receive(_ frame: Components.Schemas.SpawnProgressEvent) {
        guard !stopped, busy, frame.spawnId == spawnID else { return }
        progress = frame
    }

    public func submit(model: ComposeModel, repoResolved: Bool, holdLikely: Bool, force: Bool = false,
                events: AsyncStream<ServerEvent>? = nil,
                recovery: BackendRecoveryModel? = nil,
                create: (CreateSessionRequest, String) async throws -> CreateOutcome,
                onHeld: () -> Void = {},
                isCurrent: @escaping @MainActor () -> Bool) async -> Session? {
        await submit(model: model, repoResolved: repoResolved, holdLikely: holdLikely, force: force,
                     events: events, recovery: recovery, send: { try await create($0, $1.spawnID) },
                     onHeld: onHeld, isCurrent: isCurrent)
    }

    /// The create with its transport (#2776): while the machine choice is available every attempt
    /// is keyed, and an unanswered one is retried under the same key while the task is unchanged,
    /// so it never starts twice. A refusal about the machine reads as what is missing or out of
    /// reach rather than as a server failure.
    public func submit(model: ComposeModel, repoResolved: Bool, holdLikely: Bool, force: Bool = false,
                events: AsyncStream<ServerEvent>? = nil,
                recovery: BackendRecoveryModel? = nil,
                send: (CreateSessionRequest, CreateCall) async throws -> CreateOutcome,
                onHeld: () -> Void = {},
                isCurrent: @escaping @MainActor () -> Bool) async -> Session? {
        guard !stopped, isCurrent(), model.readiness(submitting: busy, repoResolved: repoResolved,
                                                   holdLikely: holdLikely).canSubmit,
              var request = model.createRequest(baseBranch: model.repoBranches.baseBranch) else { return nil }
        request.force = force
        let keyed = model.runOn.send(for: request)
        let machine = model.runOn.remoteTarget
        sendingTo = machine
        heldOn = nil
        recoveryFailure = nil
        busy = true; slow = false; message = nil; progress = nil; cancelRequested = false
        generation += 1
        let mine = generation, id = UUID().uuidString
        spawnID = id
        timer = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            guard let self, mine == generation, !stopped, isCurrent() else { return }
            slow = true
        }
        if let events {
            eventsTask = Task { [weak self] in
                for await event in events {
                    guard let self, mine == generation, !stopped, isCurrent(), !Task.isCancelled else { return }
                    if case .unknown(let name, let payload) = event, name == "spawn:progress", let payload,
                       let frame = try? JSONDecoder().decode(Components.Schemas.SpawnProgressEvent.self, from: payload) {
                        receive(frame)
                    }
                }
            }
        }
        defer {
            if mine == generation { finish() }
        }
        do {
            let result = try await send(request, CreateCall(spawnID: id, idempotencyKey: keyed?.key))
            model.runOn.settle(keyed, error: nil)
            guard mine == generation, !stopped, isCurrent() else { return nil }
            switch result {
            case .created(let session): return session
            case .held(let held):
                model.discardSubmittedDraft()
                message = PlacementCopy.held(held)
                heldOn = held.host
                // A task waiting for its machine or held there leaves the composer usable: a
                // client that stays open to say so can start the next task (#2776).
                if held.host == nil { teardown() }
                onHeld()
                return nil
            }
        } catch {
            model.runOn.settle(keyed, error: error)
            guard mine == generation, !stopped, isCurrent() else { return nil }
            let machineFailure = PlacementCopy.failure(error, machine: machine?.name)
            message = cancelRequested ? L.t("newtask_spawn_canceled")
                : machineFailure ?? L.t("newtask_create_failed", ShepherdErrorCopy.message(error))
            if !cancelRequested, machineFailure == nil, BackendRecovery.isCompatibleCreateFailure(error), let recovery {
                await recovery.refresh()
                guard mine == generation, !stopped, isCurrent(), !Task.isCancelled else { return nil }
                recoveryFailure = recovery.diagnosis(for: nil)
            }
            return nil
        }
    }

    public func cancel(using cancel: (String) async throws -> Bool,
                isCurrent: () -> Bool) async {
        guard !stopped, busy, !canceling, !cancelRequested, isCurrent(), let id = spawnID else { return }
        let mine = generation
        canceling = true
        defer { if mine == generation { canceling = false } }
        do {
            let canceled = try await cancel(id)
            guard mine == generation, !stopped, busy, isCurrent() else { return }
            cancelRequested = canceled
        } catch {
            guard mine == generation, !stopped, busy, isCurrent() else { return }
            // A 404 means the create completed first; its still-pending response settles the UI.
            if error as? ShepherdError != .notFound { message = ShepherdErrorCopy.message(error) }
        }
    }

    private func finish() {
        eventsTask?.cancel(); eventsTask = nil
        timer?.cancel(); timer = nil
        busy = false; slow = false; canceling = false; spawnID = nil; progress = nil; sendingTo = nil
    }
    public func teardown() {
        stopped = true; generation += 1
        recoveryFailure = nil
        finish()
    }
}
