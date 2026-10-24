import Observation
import ShepherdKit

/// A detail surface owns this state; list and event caches retain only summaries.
@Observable @MainActor
public final class RecapDetailState {
    public init() {}

    public private(set) var recap: Recap?
    public private(set) var isLoading = false
    public private(set) var error: String?
    private var generation = 0
    private var key = ""

    public static func version(sessionID: String, summary: Recap?) -> String {
        "\(sessionID):\(summary?.updatedAt ?? -1):\(summary?.state.rawValue ?? "")"
    }

    public func current(sessionID: String, summary: Recap?) -> Recap? {
        key == Self.version(sessionID: sessionID, summary: summary) ? recap : nil
    }

    public func load(sessionID: String, summary: Recap?,
                     read: (String) async throws -> Recap) async {
        guard !Task.isCancelled else { return }
        close()
        guard let summary, summary.state.known == .ready else { return }
        let mine = generation
        key = Self.version(sessionID: sessionID, summary: summary)
        isLoading = true
        defer { if mine == generation { isLoading = false } }
        do {
            let loaded = try await read(sessionID)
            guard mine == generation, !Task.isCancelled else { return }
            guard loaded.sessionId == sessionID, loaded.updatedAt >= summary.updatedAt,
                  loaded.state == summary.state else {
                error = ShepherdErrorCopy.message(ShepherdError.contractMismatch(
                    route: "getSessionRecap", underlying: "recap version changed"))
                return
            }
            recap = loaded
        } catch {
            guard mine == generation, !Task.isCancelled else { return }
            self.error = ShepherdErrorCopy.message(error)
        }
    }

    public func close() {
        generation &+= 1
        key = ""
        recap = nil
        isLoading = false
        error = nil
    }
}
