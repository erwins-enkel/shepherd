import ShepherdAppCore
import Foundation
import UserNotifications

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

    /// `false` when macOS rejected the request, so a caller can tell a banner the operator saw
    /// from one the system threw away. Still logged, still never a crash.
    @discardableResult
    func post(_ request: NotificationRequest) async -> Bool {
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
            return true
        } catch {
            // Never log the title or the body — they name the operator's own work. The
            // identifier is a UUID this type minted, so it carries nothing.
            Log.app.error(
                """
                could not post a notification: \(request.identifier, privacy: .public) \
                \(String(describing: error), privacy: .public)
                """)
            return false
        }
    }

    /// `UNUserNotificationCenter.setBadgeCount` is the badge API that does not prompt on its own:
    /// the badge permission was asked for once, together with alerts, in `requestAuthorization`.
    /// A failure is logged and answered with `false` — never a crash, and never a silent
    /// success: a stale Dock number is not worth a crash, but it is worth telling the caller
    /// about, because the caller is the only one that can write it again.
    @discardableResult
    func setBadgeCount(_ count: Int) async -> Bool {
        do {
            try await center.setBadgeCount(count)
            return true
        } catch {
            Log.app.error(
                """
                could not set the badge to \(count, privacy: .public): \
                \(String(describing: error), privacy: .public)
                """)
            return false
        }
    }

    /// The completion-handler spelling of `setBadgeCount`, which is what makes the clear
    /// synchronous: it hands the request to the shared `UNUserNotificationCenter` and returns,
    /// so the request is already *submitted* — ahead of anything the *next* profile's model
    /// submits — by the time `teardown()` returns. The `async` variant would have to be
    /// awaited, and the hop that await needs is precisely the re-ordering this method exists
    /// to avoid. (The `async` spelling calls this same ObjC entry point; what differs is only
    /// *when* the call is made.)
    ///
    /// What this buys, exactly: submission order. The last hop — `notificationd` applying two
    /// overlapping updates — is not something Apple documents as FIFO, so the guarantee rests
    /// on the shared centre's single connection delivering requests in the order they were
    /// made. That is one unproven assumption instead of the previous *two* (scheduler order
    /// for unstructured tasks, and then this), and it is the reason the clear is issued here
    /// rather than from a `Task`. A hard barrier would need a badge writer that outlives the
    /// activation and serialises every write through one owner; that is a larger change than
    /// this seam, and it is not what the profile-switch bug needed.
    func clearBadgeNow() {
        center.setBadgeCount(0) { error in
            guard let error else { return }
            Log.app.error(
                "could not clear the badge: \(String(describing: error), privacy: .public)")
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

        /// Shown, not swallowed — but not for the reason it might look like. The SDK calls
        /// `willPresent` only while the application is in the foreground, and `NotificationGate`
        /// already refuses to post while Shepherd is active (driven from
        /// `NSApplicationDidBecomeActive`/`WillResignActive` — application activation, not window
        /// key state), so this delegate method never runs for a banner the gate let through in
        /// the first place. The one case that genuinely reaches here is a banner posted while
        /// Shepherd was inactive that macOS re-presents once the operator activates the app.
        /// Showing it is preferred to dropping it: returning `[]` would also strip it from
        /// Notification Center, which is the worse failure.
        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            willPresent notification: UNNotification
        ) async -> UNNotificationPresentationOptions {
            [.banner, .list, .sound]
        }
    }
}
