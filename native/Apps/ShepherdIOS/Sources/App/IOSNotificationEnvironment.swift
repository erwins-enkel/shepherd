import Foundation
import ShepherdAppCore

/// Stage 2 is passive: no authorization request, badge or system notification.
@MainActor
final class IOSPassiveNotificationCenter: NotificationCenterClient {
    var onSelectSession: ((String) -> Void)?
    func authorization() async -> NotificationAuthorization { .denied }
    func requestAuthorization() async -> NotificationAuthorization { .denied }
    func post(_ request: NotificationRequest) async -> Bool { false }
    func setBadgeCount(_ count: Int) async -> Bool { false }
    func clearBadgeNow() {}
    func start() {}
}

@MainActor
final class IOSNotificationFocus: NotificationFocusSource {
    func sample() -> Bool { true }
    func observe(_ receive: @escaping @MainActor (Bool) -> Void) -> @MainActor () -> Void { {} }
}

@MainActor
enum IOSNotificationEnvironment {
    static func make(defaults: UserDefaults) -> NotificationEnvironment {
        NotificationEnvironment(makeCenter: { IOSPassiveNotificationCenter() },
            makeDefaults: { defaults }, focus: IOSNotificationFocus())
    }
}
