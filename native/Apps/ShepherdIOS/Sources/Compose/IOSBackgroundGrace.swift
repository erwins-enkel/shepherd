import UIKit

/// iOS's finite background budget (roughly 30 seconds, never guaranteed) for work the
/// operator started: a brief app switch must not cut an upload or a create in flight.
@MainActor enum IOSBackgroundGrace {
    @MainActor private final class Handle {
        var id = UIBackgroundTaskIdentifier.invalid
        func end() {
            guard id != .invalid else { return }
            UIApplication.shared.endBackgroundTask(id)
            id = .invalid
        }
    }

    /// Returns the idempotent release; expiry releases it too.
    static func begin(_ name: String) -> @MainActor () -> Void {
        let handle = Handle()
        handle.id = UIApplication.shared.beginBackgroundTask(withName: name) {
            MainActor.assumeIsolated { handle.end() }
        }
        return { handle.end() }
    }
}
