import Foundation
import UserNotifications

/// One banner to post. Not a server payload — it never crosses the wire — so it is an ordinary
/// value type and the "no hand-written Codable" rule does not apply.
struct NotificationRequest: Equatable, Sendable {
    /// Unique per post. `UNUserNotificationCenter` replaces a pending request with the same
    /// identifier, so reusing one would let a second session's banner eat the first's.
    let identifier: String
    let title: String
    let body: String
    /// Groups a session's banners in Notification Centre — the macOS analogue of the web
    /// service worker's `tag`.
    let threadIdentifier: String
    /// What a click selects. `nil` for the host-global usage warning, which just opens the app.
    let sessionID: String?

    static func make(
        title: String, body: String, threadIdentifier: String, sessionID: String?
    ) -> NotificationRequest {
        NotificationRequest(
            identifier: UUID().uuidString, title: title, body: body,
            threadIdentifier: threadIdentifier, sessionID: sessionID)
    }
}

/// What macOS currently allows.
enum NotificationAuthorization: Equatable, Sendable {
    case notDetermined
    case granted
    case denied
}

/// The seam between this stream and `UserNotifications`.
///
/// Every test drives `FakeNotificationCenter` through this protocol, which is what keeps the
/// suite from popping the macOS permission alert — an unattended run that stalls behind a system
/// dialog is exactly the failure the repo's "no prompts" rule exists to prevent.
@MainActor
protocol NotificationCenterClient: AnyObject {
    /// Called on the main actor when the operator clicks a banner carrying a session id.
    var onSelectSession: ((String) -> Void)? { get set }
    func authorization() async -> NotificationAuthorization
    func requestAuthorization() async -> NotificationAuthorization
    func post(_ request: NotificationRequest) async
    func setBadgeCount(_ count: Int) async
    /// Installs the click handler. Called once, after `onSelectSession` is set; calling it again
    /// is a no-op on both implementations.
    func start()
}

/// The real thing. The only type in the whole app that touches `UNUserNotificationCenter` —
/// everything else, including previews and every isolated launch, goes through the protocol.
@MainActor
final class SystemNotificationCenter: NotificationCenterClient {
    var onSelectSession: ((String) -> Void)?

    private let center = UNUserNotificationCenter.current()
    /// `UNUserNotificationCenter.delegate` is `weak`, so the shim has to be owned here or macOS
    /// would drop it the moment `start()` returned and no click would ever arrive.
    private lazy var delegate = ResponseDelegate { [weak self] id in self?.onSelectSession?(id) }
    /// `start()` is idempotent. Re-running it would rebuild nothing (the shim is `lazy`) but the
    /// flag makes that a documented guarantee rather than an accident of `lazy`.
    private var didStart = false

    /// Key in the banner's `userInfo` carrying the session id. Read back in `ResponseDelegate`,
    /// which is not main-actor isolated — hence `nonisolated`.
    nonisolated static let sessionKey = "shepherd.sessionID"

    func start() {
        guard !didStart else { return }
        didStart = true
        center.delegate = delegate
    }

    /// `.provisional` counts as granted: a provisionally authorized app may post quietly, which
    /// is still a banner the operator can see in Notification Centre, and treating it as denied
    /// would make the app nag for permission it already has. `.ephemeral` is deliberately absent
    /// — it is App Clips only and `API_UNAVAILABLE(macos)`, so naming it here would not compile.
    /// `@unknown default` sends any case a future macOS adds to `.denied`: the conservative end,
    /// and it cannot trap the way an unhandled `switch` would.
    func authorization() async -> NotificationAuthorization {
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined: .notDetermined
        case .authorized, .provisional: .granted
        case .denied: .denied
        @unknown default: .denied
        }
    }

    func requestAuthorization() async -> NotificationAuthorization {
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            return granted ? .granted : .denied
        } catch {
            Log.app.error(
                "notification authorization failed: \(String(describing: error), privacy: .public)")
            return .denied
        }
    }

    func post(_ request: NotificationRequest) async {
        let content = UNMutableNotificationContent()
        content.title = request.title
        content.body = request.body
        content.threadIdentifier = request.threadIdentifier
        content.sound = .default
        if let sessionID = request.sessionID {
            content.userInfo = [Self.sessionKey: sessionID]
        }
        do {
            // `trigger: nil` delivers immediately.
            try await center.add(
                UNNotificationRequest(
                    identifier: request.identifier, content: content, trigger: nil))
        } catch {
            // Never log the title or the body — they name the operator's own work. The
            // identifier is a UUID this type minted, so it carries nothing.
            Log.app.error(
                """
                could not post a notification: \(request.identifier, privacy: .public) \
                \(String(describing: error), privacy: .public)
                """)
        }
    }

    /// `UNUserNotificationCenter.setBadgeCount` is the badge API that does not prompt on its own:
    /// the badge permission was asked for once, together with alerts, in `requestAuthorization`.
    /// A failure is logged and swallowed — a stale dock number is never worth a crash.
    func setBadgeCount(_ count: Int) async {
        do {
            try await center.setBadgeCount(count)
        } catch {
            Log.app.error(
                """
                could not set the badge to \(count, privacy: .public): \
                \(String(describing: error), privacy: .public)
                """)
        }
    }

    /// Forwards a click to the closure.
    ///
    /// `UNUserNotificationCenterDelegate` is an `@objc` protocol whose callbacks arrive on an
    /// arbitrary thread, so the delegate cannot be the main-actor class itself. It is instead a
    /// small `Sendable` shim holding one immutable `@MainActor` closure: nothing here is mutable,
    /// so the conformance is checked rather than asserted — no `@preconcurrency`, no
    /// `@unchecked Sendable`, no `nonisolated(unsafe)`.
    private final class ResponseDelegate: NSObject, UNUserNotificationCenterDelegate, Sendable {
        private let onSelect: @Sendable @MainActor (String) -> Void

        init(onSelect: @escaping @Sendable @MainActor (String) -> Void) {
            self.onSelect = onSelect
        }

        /// The `async` spelling of `…didReceiveNotificationResponse:withCompletionHandler:`. The
        /// system calls it once per tap and the hop below runs the handler once, on the main
        /// actor. The session id is read off `userInfo` *before* the hop, so nothing
        /// non-`Sendable` crosses it.
        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            didReceive response: UNNotificationResponse
        ) async {
            let info = response.notification.request.content.userInfo
            guard let id = info[SystemNotificationCenter.sessionKey] as? String else { return }
            await MainActor.run { self.onSelect(id) }
        }

        /// Shown, not swallowed. `NotificationGate` already refuses to post anything while the
        /// Shepherd window is focused, so a banner that reaches macOS at all is one the operator
        /// asked to see — returning `[]` here would silently drop exactly those: the app is
        /// frontmost but the window is behind something, minimised or on another Space.
        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            willPresent notification: UNNotification
        ) async -> UNNotificationPresentationOptions {
            [.banner, .list, .sound]
        }
    }
}

/// Records instead of posting. Used by every test, by previews, and — deliberately — by an
/// isolated launch, so an automated run never asks macOS for permission. It references nothing
/// from `UserNotifications`.
@MainActor
final class FakeNotificationCenter: NotificationCenterClient {
    var onSelectSession: ((String) -> Void)?
    private(set) var posted: [NotificationRequest] = []
    private(set) var badge = 0
    private(set) var authorizationRequests = 0
    /// How many times `start()` was called. `started` is the boolean a caller usually wants; the
    /// count is what proves the idempotence the protocol promises.
    private(set) var starts = 0
    var started: Bool { starts > 0 }
    var nextAuthorization: NotificationAuthorization = .granted

    func start() { starts += 1 }
    func authorization() async -> NotificationAuthorization { nextAuthorization }

    func requestAuthorization() async -> NotificationAuthorization {
        authorizationRequests += 1
        return nextAuthorization
    }

    func post(_ request: NotificationRequest) async { posted.append(request) }
    func setBadgeCount(_ count: Int) async { badge = count }

    /// Test seam: pretend the operator clicked a banner for `sessionID`.
    func deliverClick(sessionID: String) { onSelectSession?(sessionID) }

    /// Clears the recording. Deliberately keeps `onSelectSession` and `nextAuthorization`, which
    /// are the fixture a test set up, not the evidence it is about to assert on.
    func reset() {
        posted.removeAll()
        badge = 0
        authorizationRequests = 0
    }
}
