import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit
import UIKit
import UserNotifications

/// Native push, interim direct-APNs transport (#2665): asks once for permission, hands the
/// device token to the active server and opens the session a tapped notification names.
/// The server decides what to send; this side only registers and routes.
@MainActor
@Observable
final class IOSPushRegistration {
    static let shared = IOSPushRegistration()

    enum State: Equatable {
        case idle, denied, registered, unavailable
        case failed(String)
    }

    private(set) var state: State = .idle
    @ObservationIgnored private var token: String?
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var enabled = false
    @ObservationIgnored private var pendingSessionID: String?
    @ObservationIgnored private var registeredFor: ObjectIdentifier?

    /// Debug builds talk to the APNs sandbox; TestFlight and App Store builds to production.
    static var usesSandbox: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    /// Notification language follows the device, limited to the two the server writes.
    static var locale: String { Locale.current.language.languageCode?.identifier == "de" ? "de" : "en" }

    static func hex(_ token: Data) -> String { token.map { String(format: "%02x", $0) }.joined() }

    /// Isolated launches (tests, live smoke) never prompt and never register.
    func attach(_ app: AppModel, enabled: Bool) {
        self.app = app
        self.enabled = enabled
        if let id = pendingSessionID { pendingSessionID = nil; open(id) }
    }

    /// A new store means a new server or a fresh login: register this device there.
    func storeChanged() {
        guard enabled, let store = app?.store else { return }
        if let token { Task { await register(token, store: store) } }
        else { Task { await requestPermission() } }
    }

    private func requestPermission() async {
        let center = UNUserNotificationCenter.current()
        do {
            guard try await center.requestAuthorization(options: [.alert, .sound, .badge]) else {
                state = .denied
                return
            }
        } catch {
            state = .failed(error.localizedDescription)
            return
        }
        UIApplication.shared.registerForRemoteNotifications()
    }

    func didRegister(deviceToken: Data) {
        let hex = Self.hex(deviceToken)
        token = hex
        guard enabled, let store = app?.store else { return }
        Task { await register(hex, store: store) }
    }

    func didFailToRegister(_ error: any Error) {
        state = .failed(error.localizedDescription)
    }

    private func register(_ token: String, store: SessionStore) async {
        let id = ObjectIdentifier(store)
        do {
            switch try await store.client.registerApnsDevice(token: token, sandbox: Self.usesSandbox,
                locale: Self.locale) {
            case .registered:
                registeredFor = id
                state = .registered
            case .unavailable:
                state = .unavailable
            }
        } catch {
            state = .failed(ShepherdErrorCopy.message(error))
        }
    }

    /// A tapped notification opens its session; host-wide alerts (no session) just open the app.
    func open(_ sessionID: String) {
        guard !sessionID.isEmpty else { return }
        guard let app else { pendingSessionID = sessionID; return }
        app.selectedSessionID = sessionID
    }
}

/// UIKit owns the APNs callbacks and the notification-center delegate; both forward to
/// ``IOSPushRegistration``.
final class IOSAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        MainActor.assumeIsolated { IOSPushRegistration.shared.didRegister(deviceToken: token) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        MainActor.assumeIsolated { IOSPushRegistration.shared.didFailToRegister(error) }
    }

    /// The server already stays quiet while the app is in active use, so anything that still
    /// arrives in the foreground is worth showing.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let sessionID = response.notification.request.content.userInfo["sessionId"] as? String ?? ""
        await IOSPushRegistration.shared.open(sessionID)
    }
}
