import ShepherdKit
import UserNotifications

/// Each server's push knows only its own count; opening the app corrects the connected-server sum.
@MainActor
final class IOSAppBadge {
    private var lastCount: Int?
    private var pending: Task<Void, Never>?
    private let write: @MainActor (Int) async -> Void

    init(write: @escaping @MainActor (Int) async -> Void = { count in
        try? await UNUserNotificationCenter.current().setBadgeCount(count)
    }) {
        self.write = write
    }

    static func count(_ sessions: [Session]) -> Int {
        sessions.filter { $0.status.known == .blocked || $0.status.known == .idle }.count
    }

    static func sum(_ servers: [[Session]]) -> Int {
        servers.reduce(0) { $0 + count($1) }
    }

    func update(_ count: Int, enabled: Bool, background: Bool = false) async {
        guard enabled, background || count != lastCount else { return }
        // A server may replace the sum while suspended; the next foreground sample must repair it.
        lastCount = background ? nil : count
        let previous = pending
        let write = write
        let task = Task {
            await previous?.value
            await write(count)
        }
        pending = task
        await task.value
    }
}
