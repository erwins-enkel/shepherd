import Foundation
import ShepherdAppCore
import ShepherdKit

/// Activation-scoped discovery shared by composer and terminal recordings.
/// Unknown/network failures remain retryable; definitive status is reused.
@MainActor
final class IOSWhisperStatus {
    private let read: @Sendable () async throws -> Bool
    private var cached: Bool?
    private var pending: Task<Bool, any Error>?
    private var invalidated = false

    init(read: @escaping @Sendable () async throws -> Bool) { self.read = read }

    func value() async throws -> Bool {
        guard !invalidated else { throw CancellationError() }
        if let cached { return cached }
        if let pending {
            let answer = try await pending.value
            guard !invalidated else { throw CancellationError() }
            return answer
        }
        let task = Task { try await read() }
        pending = task
        defer { pending = nil }
        let answer = try await task.value
        guard !invalidated else { throw CancellationError() }
        cached = answer
        return answer
    }

    func teardown() { invalidated = true; pending?.cancel(); pending = nil; cached = nil }
}

/// Both text destinations use the same capture, Apple preview and Whisper finalizer.
@MainActor
struct IOSDictationSession {
    let engine: IOSDictationEngine
    let voice: DictationController

    init(client: ShepherdClient, defaults: UserDefaults, context: [String],
         whisperStatus: IOSWhisperStatus? = nil,
         getText: @escaping () -> String, setText: @escaping (String) -> Void) {
        var services = IOSDictationServices.live(client: client)
        if let whisperStatus { services.whisper = { try await whisperStatus.value() } }
        let engine = IOSDictationEngine(client: client, defaults: defaults, context: context, services: services)
        self.engine = engine
        voice = DictationController(engine: engine,
            finalizer: WhisperFinalizer(client: client, status: { try await engine.resolvedWhisperAvailability() }),
            defaults: defaults, getText: getText, setText: setText)
    }
}
