import Foundation
import Observation
import ShepherdKit

/// Presentation-owned create. A cancellation request never cancels the HTTP response: it may
/// report that the agent won the race. Only that response can settle the submission.
@Observable @MainActor
final class ComposeSubmission {
    private(set) var busy = false
    private(set) var slow = false
    private(set) var canceling = false
    private(set) var cancelRequested = false
    private(set) var spawnID: String?
    private(set) var progress: Components.Schemas.SpawnProgressEvent?
    private(set) var message: String?
    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    @ObservationIgnored private var timer: Task<Void, Never>?
    private var generation = 0
    private var stopped = false

    func receive(_ frame: Components.Schemas.SpawnProgressEvent) {
        guard !stopped, busy, frame.spawnId == spawnID else { return }
        progress = frame
    }

    func submit(model: ComposeModel, repoResolved: Bool, holdLikely: Bool, force: Bool = false,
                events: AsyncStream<ServerEvent>? = nil,
                create: (CreateSessionRequest, String) async throws -> CreateOutcome,
                isCurrent: @escaping @MainActor () -> Bool) async -> Session? {
        guard !stopped, isCurrent(), model.readiness(submitting: busy, repoResolved: repoResolved,
                                                   holdLikely: holdLikely).canSubmit,
              var request = model.createRequest(baseBranch: model.repoBranches.baseBranch) else { return nil }
        request.force = force
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
            let result = try await create(request, id)
            guard mine == generation, !stopped, isCurrent() else { return nil }
            switch result {
            case .created(let session): return session
            case .held: message = L.t("native_newsession_held"); return nil
            }
        } catch {
            guard mine == generation, !stopped, isCurrent() else { return nil }
            message = cancelRequested ? L.t("newtask_spawn_canceled")
                : L.t("newtask_create_failed", ShepherdErrorCopy.message(error))
            return nil
        }
    }

    func cancel(using cancel: (String) async throws -> Bool,
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
        busy = false; slow = false; canceling = false; spawnID = nil; progress = nil
    }
    func teardown() {
        stopped = true; generation += 1
        finish()
    }
}
