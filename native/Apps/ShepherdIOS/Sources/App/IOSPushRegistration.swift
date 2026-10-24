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
    @ObservationIgnored private var pending: (sessionID: String, server: String?, instance: String?)?
    @ObservationIgnored private var notificationLookup: Task<Void, Never>?
    var isResolvingNotification: Bool { notificationLookup != nil }
    @ObservationIgnored private var registeredFor: [ObjectIdentifier: Registration] = [:]
    private final class Registration {
        weak var store: SessionStore?
        let token: String
        let relay: ApnsRelay?
        init(store: SessionStore, token: String, relay: ApnsRelay?) { self.store = store; self.token = token; self.relay = relay }
    }
    /// Saved servers this device is registered with, by profile ID → instance ID (#3059). Kept
    /// across launches so a parked server, which still notifies this phone, still counts.
    static let coverageKey = "run.shepherd.ios.push.coverage"
    /// Servers whose "mirrored machines" switch is off, by profile ID.
    static let relayOffKey = "run.shepherd.ios.push.relayOff"
    @ObservationIgnored var defaults: UserDefaults = .standard
    private(set) var relayOff: Set<UUID> = []
    /// What each connected server answered, so the menu can say whether the FOCUSED server can
    /// reach this phone (#2696) — `state` alone only holds whichever answer came last.
    private var outcomes: [ObjectIdentifier: Outcome] = [:]
    private final class Outcome {
        weak var store: SessionStore?
        let state: State
        init(store: SessionStore, state: State) { self.store = store; self.state = state }
    }
    @ObservationIgnored private var registering: Set<ObjectIdentifier> = []
    @ObservationIgnored private var permissionRequested = false
    @ObservationIgnored var registerDevice: @MainActor (SessionStore, String, ApnsRelay?) async throws -> ApnsRegistrationOutcome = { store, token, relay in
        try await store.client.registerApnsDevice(token: token, sandbox: IOSPushRegistration.usesSandbox,
                                                  locale: IOSPushRegistration.locale, relay: relay)
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
        relayOff = Set((defaults.stringArray(forKey: Self.relayOffKey) ?? []).compactMap(UUID.init(uuidString:)))
        routePendingNotification()
    }

    /// Isolated launches never register, so they have no status to show.
    var isEnabled: Bool { enabled }

    /// Push for one server: denied is device-wide; otherwise that server's own answer, and
    /// `idle` until it has answered.
    func status(for store: SessionStore?) -> State {
        if state == .denied { return .denied }
        guard let store, let outcome = outcomes[ObjectIdentifier(store)], outcome.store === store
        else { return .idle }
        return outcome.state
    }

    /// One line for the settings menu: whether this server can reach this phone, and what to do
    /// when it cannot (#2696).
    func statusText(for store: SessionStore?) -> String {
        switch status(for: store) {
        case .registered: L.t("native_ios_push_registered")
        case .unavailable: L.t("native_ios_push_unavailable")
        case .denied: L.t("native_ios_push_denied")
        case .idle: L.t("native_ios_push_pending")
        case .failed(let message): L.t("native_ios_push_failed", message)
        }
    }

    /// A new store means a new server or a fresh login: register this device there.
    func storeChanged() {
        guard enabled, let hub, hub.connected.contains(where: { $0.store != nil }) else { return }
        registeredFor = registeredFor.filter { $0.value.store != nil }
        outcomes = outcomes.filter { $0.value.store != nil }
        recordCoverage()
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
        let relay = relay(for: store)
        guard registeredFor[id]?.store !== store || registeredFor[id]?.token != token || registeredFor[id]?.relay != relay else { return }
        guard registering.insert(id).inserted else { return }
        defer {
            registering.remove(id)
            if self.token != token || self.relay(for: store) != relay { storeChanged() }
        }
        do {
            let outcome = try await registerDevice(store, token, relay)
            guard hub?.connected.contains(where: { $0.store === store }) == true else { return }
            registeredFor[id] = Registration(store: store, token: token, relay: relay)
            switch outcome {
            case .registered:
                state = .registered
            case .unavailable:
                state = .unavailable
            }
            outcomes[id] = Outcome(store: store, state: state)
            // This server joining (or leaving) the coverage changes what the others must skip.
            if recordCoverage() { storeChanged() }
        } catch {
            guard hub?.connected.contains(where: { $0.store === store }) == true else { return }
            state = .failed(ShepherdErrorCopy.message(error))
            outcomes[id] = Outcome(store: store, state: state)
        }
    }

    /// What a server that relays mirrored machines (#3058) needs to skip and whether to relay at
    /// all; `nil` for servers that do not report it, which get the registration they always had.
    private func relay(for store: SessionStore) -> ApnsRelay? {
        guard let hub, let profileID = hub.connectedIDs.first(where: { hub.models[$0]?.store === store }),
              let identity = hub.models[profileID]?.extension(IOSInstanceIdentity.self), identity.pushRelay else { return nil }
        let covered = coverage().filter { $0.key != profileID && $0.value != identity.instanceID }.values
        return ApnsRelay(coveredInstances: Set(covered).sorted(), relayRemote: !relayOff.contains(profileID))
    }

    /// Saved servers this device is registered with; removed servers drop out.
    private func coverage() -> [UUID: String] {
        let saved = Set(hub?.profiles.map(\.id) ?? [])
        let raw = defaults.dictionary(forKey: Self.coverageKey) as? [String: String] ?? [:]
        return raw.reduce(into: [:]) { result, entry in
            if let id = UUID(uuidString: entry.key), saved.contains(id) { result[id] = entry.value }
        }
    }

    /// Notes which connected servers can reach this phone now; true when that changed.
    @discardableResult
    private func recordCoverage() -> Bool {
        guard let hub else { return false }
        let before = coverage()
        var after = before
        for profileID in hub.connectedIDs {
            guard let app = hub.models[profileID], let store = app.store,
                  let instanceID = app.extension(IOSInstanceIdentity.self)?.instanceID,
                  let outcome = outcomes[ObjectIdentifier(store)], outcome.store === store else { continue }
            if outcome.state == .registered { after[profileID] = instanceID }
            else if outcome.state == .unavailable { after.removeValue(forKey: profileID) }
        }
        let stored = defaults.dictionary(forKey: Self.coverageKey) as? [String: String] ?? [:]
        let next = Dictionary(uniqueKeysWithValues: after.map { ($0.key.uuidString, $0.value) })
        if stored != next { defaults.set(next, forKey: Self.coverageKey) }
        return before != after
    }

    func relaysMirrored(_ profileID: UUID) -> Bool { !relayOff.contains(profileID) }

    /// The per-server "mirrored machines" switch; the server learns it on re-registration.
    func setRelaysMirrored(_ on: Bool, for profileID: UUID) {
        if on { relayOff.remove(profileID) } else { relayOff.insert(profileID) }
        defaults.set(relayOff.map(\.uuidString).sorted(), forKey: Self.relayOffKey)
        storeChanged()
    }

    /// A tapped notification opens its session; host-wide alerts (no session) just open the app.
    /// `instance` names the machine that runs the session (#3058).
    func open(_ sessionID: String, server: String? = nil, instance: String? = nil) {
        guard !sessionID.isEmpty else { return }
        notificationLookup?.cancel()
        notificationLookup = nil
        pending = (sessionID, server, instance)
        routePendingNotification()
    }

    func routePendingNotification() {
        guard let pending, let hub else { return }
        let targets = hub.notificationTargets(sessionID: pending.sessionID, server: pending.server, instance: pending.instance)
        // Let connecting stores finish their first lookup; an offline peer must not block
        // a notification whose session is already available on another server.
        // A session's own machine may be saved here too: it counts as a lookup still ahead
        // until each reachable server said who it is.
        if pending.server == nil, hub.connected.contains(where: hub.awaitsNotificationLookup) ||
            (pending.instance != nil && hub.connected.contains(where: hub.awaitsInstanceIdentity)) {
            // Keep collision safety without withholding an already available session.
            notificationChoices = targets
            return
        }
        if targets.count == 1, let target = targets.first {
            guard let store = hub.models[target.profileID]?.store, store.hasLoadedSessions, store.connection != .needsLogin else { return }
            if store.session(id: pending.sessionID) != nil || store.remoteSession(id: pending.sessionID) != nil ||
                hub.models[target.profileID]?.extension(QueuesModel.self)?.finishedSessions.contains(where: { $0.id == pending.sessionID }) == true ||
                hub.models[target.profileID]?.extension(QueuesModel.self)?.notificationSession?.id == pending.sessionID {
                chooseNotification(target)
            } else { lookupNotification(pending, targets: targets) }
        }
        else if targets.count > 1 { notificationChoices = targets }
        else { lookupNotification(pending, targets: []) }
    }

    private func lookupNotification(_ target: (sessionID: String, server: String?, instance: String?), targets: [IOSSessionIdentity]) {
        guard let hub, notificationLookup == nil else { return }
        let candidates = targets.isEmpty ? hub.connectedIDs.filter { id in
            guard let model = hub.models[id], model.store?.hasLoadedSessions == true else { return false }
            if let server = target.server, !server.isEmpty {
                guard let profile = model.activeProfile else { return false }
                return server == id.uuidString || URL(string: server) == profile.baseURL
            }
            if let instance = target.instance, let known = model.extension(IOSInstanceIdentity.self)?.instanceID {
                return instance == known
            }
            return true
        } : targets.map(\.profileID)
        guard !candidates.isEmpty else { return }
        notificationLookup = Task { [weak self, weak hub] in
            guard let hub else { return }
            for id in candidates {
                guard !Task.isCancelled else { return }
                _ = await hub.models[id]?.extension(QueuesModel.self)?.resolveNotificationSession(id: target.sessionID)
            }
            guard let self, !Task.isCancelled, self.hub === hub, self.pending?.sessionID == target.sessionID,
                  self.pending?.server == target.server, self.pending?.instance == target.instance else { return }
            self.notificationLookup = nil
            let resolved = hub.notificationTargets(sessionID: target.sessionID, server: target.server, instance: target.instance)
                .filter { hub.models[$0.profileID]?.extension(QueuesModel.self)?.notificationSession?.id == target.sessionID }
            if resolved.count == 1, let identity = resolved.first { self.chooseNotification(identity) }
            else { self.notificationChoices = resolved }
        }
    }

    func chooseNotification(_ identity: IOSSessionIdentity) {
        hub?.select(identity)
        hub?.managingServers = false
        notificationLookup?.cancel()
        notificationLookup = nil
        pending = nil
        notificationChoices = []
    }
    func cancelNotification() {
        notificationLookup?.cancel(); notificationLookup = nil
        pending = nil; notificationChoices = []
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
        let info = response.notification.request.content.userInfo
        let server = (info["serverURL"] ?? info["baseURL"] ?? info["serverId"] ?? info["server"]) as? String
        await IOSPushRegistration.shared.open(sessionID, server: server, instance: info["instanceId"] as? String)
    }
}
