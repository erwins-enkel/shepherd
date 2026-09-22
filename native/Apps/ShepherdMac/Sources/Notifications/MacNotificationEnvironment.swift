import AppKit
import Foundation
import ShepherdAppCore

@MainActor
enum MacNotificationEnvironment {
    static func make(configuration: LaunchEnvironment.Configuration) -> NotificationEnvironment {
        let isolated = configuration.isIsolated
        return NotificationEnvironment(
            makeCenter: {
                if isolated { return FakeNotificationCenter() }
                return SystemNotificationCenter()
            },
            makeDefaults: {
                isolated
                    ? (UserDefaults(suiteName: "run.shepherd.mac.notifications.isolated.\(UUID().uuidString)") ?? .standard)
                    : .standard
            },
            focus: MacNotificationFocusSource())
    }
}

@MainActor
final class MacNotificationFocusSource: NotificationFocusSource {
    private var observers: [UUID: [any NSObjectProtocol]] = [:]
    var observerCountForTesting: Int { observers.values.reduce(0) { $0 + $1.count } }
    func sample() -> Bool { NSApp?.isActive ?? false }
    func observe(_ receive: @escaping @MainActor (Bool) -> Void) -> @MainActor () -> Void {
        let id = UUID()
        let names: [(Notification.Name, Bool)] = [
            (.init("NSApplicationDidBecomeActiveNotification"), true),
            (.init("NSApplicationWillResignActiveNotification"), false)]
        observers[id] = names.map { name, focused in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { _ in
                MainActor.assumeIsolated { receive(focused) }
            }
        }
        return { [self] in
            guard let tokens = observers.removeValue(forKey: id) else { return }
            for token in tokens { NotificationCenter.default.removeObserver(token) }
        }
    }
}
