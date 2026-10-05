import Foundation

/// Serializes credential mutations across replacement models of one profile.
/// Opt-in: the single-model host keeps its existing authentication behavior.
@MainActor
public final class AppAuthenticationQueue {
    private var tail: Task<Void, Never>?
    public init() {}

    public func run(_ operation: @escaping @MainActor () async throws -> Void) async throws {
        let previous = tail
        let work = Task { @MainActor in
            await previous?.value
            try await operation()
        }
        tail = Task { _ = try? await work.value }
        try await work.value
    }

    public func waitForIdle() async { await tail?.value }
}
