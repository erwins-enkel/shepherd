import Foundation
import Observation
import ShepherdKit

/// One reply at a time, with feedback independent of the terminal's retained iOS draft.
@MainActor
@Observable
public final class SteerSendState {
    public enum Phase: Equatable { case idle, sending, sent, failed(String) }
    public private(set) var phases: [String: Phase] = [:]
    public private(set) var sendingID: String?
    public private(set) var failedID: String?
    private var revision = 0
    private var attempts: [String: Int] = [:]
    private let settle: @MainActor () async throws -> Void

    public init(settle: @escaping @MainActor () async throws -> Void = {
        try await Task.sleep(for: .seconds(1.5))
    }) { self.settle = settle }

    public func phase(for id: String) -> Phase { phases[id] ?? .idle }

    public func send(_ steer: ComposeSteer, allowed: () -> Bool,
                     reply: (String) async throws -> Void) async {
        guard allowed(), sendingID == nil,
              !steer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let mine = revision
        let attempt = (attempts[steer.id] ?? 0) + 1
        attempts[steer.id] = attempt
        sendingID = steer.id
        if let failedID { phases[failedID] = .idle }
        failedID = nil
        phases[steer.id] = .sending
        do {
            try await reply(steer.text)
        } catch {
            guard mine == revision else { return }
            sendingID = nil
            guard allowed(), !Task.isCancelled else { phases[steer.id] = .idle; return }
            failedID = steer.id
            phases[steer.id] = .failed(L.t("native_terminal_prompt_failed", ShepherdErrorCopy.message(error)))
            return
        }
        guard mine == revision else { return }
        sendingID = nil
        guard allowed(), !Task.isCancelled else { phases[steer.id] = .idle; return }
        phases[steer.id] = .sent
        try? await settle()
        // A repeat click has its own timer; an older one cannot clear its feedback.
        guard mine == revision, attempts[steer.id] == attempt else { return }
        phases[steer.id] = .idle
    }

    public func reset() {
        revision += 1
        phases = [:]
        attempts = [:]
        sendingID = nil
        failedID = nil
    }
}
