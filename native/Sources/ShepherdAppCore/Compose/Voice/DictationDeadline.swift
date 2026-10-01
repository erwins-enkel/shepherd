import Foundation

/// A deadline that also bounds a transport which ignores cancellation. Unlike a task group,
/// returning does not wait for the losing operation. A finished stream rejects late values.
@MainActor public enum DictationDeadline {
    public static func value<T: Sendable>(seconds: TimeInterval,
        operation: @escaping @Sendable () async -> T) async -> T? {
        let pair = AsyncStream<T>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let worker = Task { pair.continuation.yield(await operation()); pair.continuation.finish() }
        let timer = Task {
            do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            pair.continuation.finish()
        }
        defer { worker.cancel(); timer.cancel(); pair.continuation.finish() }
        return await withTaskCancellationHandler {
            var iterator = pair.stream.makeAsyncIterator()
            return await iterator.next()
        } onCancel: { pair.continuation.finish() }
    }
}
