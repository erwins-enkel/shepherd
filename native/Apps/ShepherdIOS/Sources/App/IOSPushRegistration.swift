import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit
import UIKit
import UserNotifications

/// Native push, interim direct-APNs transport (#2665): asks once for permission, hands the
/// device token to every connected server and routes tapped notifications by origin.
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
    @ObservationIgnored private weak var hub: IOSServerHub?
    @ObservationIgnored private var enabled = false
    @ObservationIgnored private var pending: (sessionID: String, server: String?)?
    @ObservationIgnored private var registeredFor: [ObjectIdentifier: Registration] = [:]
    private final class Registration {
        weak var store: SessionStore?
        let token: String
        init(store: SessionStore, token: String) { self.store = store; self.token = token }
    }
    @ObservationIgnored private var registering: Set<ObjectIdentifier> = []
    @ObservationIgnored private var permissionRequested = false
    @ObservationIgnored var registerDevice: @MainActor (SessionStore, String) async throws -> ApnsRegistrationOutcome = { store, token in
        try await store.client.registerApnsDevice(token: token, sandbox: IOSPushRegistration.usesSandbox, locale: IOSPushRegistration.locale)
    }
    private(set) var notificationChoices: [IOSSessionIdentity] = []

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
    func attach(_ hub: IOSServerHub, enabled: Bool) {
        self.hub = hub
        self.enabled = enabled
        routePendingNotification()
    }

    /// A new store means a new server or a fresh login: register this device there.
    func storeChanged() {
        guard enabled, let hub, hub.connected.contains(where: { $0.store != nil }) else { return }
        registeredFor = registeredFor.filter { $0.value.store != nil }
        if let token {
            for app in hub.connected {
                if let store = app.store { Task { await register(token, store: store) } }
            }
        } else if !permissionRequested {
            permissionRequested = true
            Task { await requestPermission() }
        }
        routePendingNotification()
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
        storeChanged()
    }

    func didFailToRegister(_ error: any Error) {
        state = .failed(error.localizedDescription)
    }

    private func register(_ token: String, store: SessionStore) async {
        let id = ObjectIdentifier(store)
        guard registeredFor[id]?.store !== store || registeredFor[id]?.token != token else { return }
        guard registering.insert(id).inserted else { return }
        defer {
            registering.remove(id)
            if self.token != token { storeChanged() }
        }
        do {
            let outcome = try await registerDevice(store, token)
            guard hub?.connected.contains(where: { $0.store === store }) == true else { return }
            registeredFor[id] = Registration(store: store, token: token)
            switch outcome {
            case .registered:
                state = .registered
            case .unavailable:
                state = .unavailable
            }
        } catch {
            guard hub?.connected.contains(where: { $0.store === store }) == true else { return }
            state = .failed(ShepherdErrorCopy.message(error))
        }
    }

    /// A tapped notification opens its session; host-wide alerts (no session) just open the app.
    func open(_ sessionID: String, server: String? = nil) {
        guard !sessionID.isEmpty else { return }
        pending = (sessionID, server)
        routePendingNotification()
    }

    func routePendingNotification() {
        guard let pending, let hub else { return }
        let targets = hub.notificationTargets(sessionID: pending.sessionID, server: pending.server)
        // Let connecting stores finish their first lookup; an offline peer must not block
        // a notification whose session is already available on another server.
        guard pending.server != nil || !hub.connected.contains(where: hub.awaitsNotificationLookup) else { return }
        if targets.count == 1, let target = targets.first {
            guard let store = hub.models[target.profileID]?.store, store.hasLoadedSessions, store.connection != .needsLogin else { return }
            chooseNotification(target)
        }
        else if targets.count > 1 { notificationChoices = targets }
    }

    func chooseNotification(_ identity: IOSSessionIdentity) {
        hub?.select(identity)
        hub?.managingServers = false
        pending = nil
        notificationChoices = []
    }
    func cancelNotification() { pending = nil; notificationChoices = [] }

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
        let info = response.notification.request.content.userInfo
        let server = (info["serverURL"] ?? info["baseURL"] ?? info["serverId"] ?? info["server"]) as? String
        await IOSPushRegistration.shared.open(sessionID, server: server)
    }
}
