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
    /// Delivers one banner and says whether it really went out — the seam's port of the web's
    /// `notify()` answering `sent`. A caller that latches state on a banner having reached the
    /// operator (the usage warning's 5-hour window) must branch on this, never on the call
    /// having returned: macOS rejects a request often enough that latching on a rejection
    /// would silence the rest of that window with nothing delivered. `@discardableResult`
    /// because most callers post and move on.
    @discardableResult
    func post(_ request: NotificationRequest) async -> Bool
    /// Sets the Dock badge and says whether the write really landed — the same shape as `post`,
    /// and for the same reason. A caller that caches the count it wrote (to spare itself an XPC
    /// round trip per event frame) must not cache one macOS rejected: the Dock would then stay
    /// wrong until the derived count next moves. `@discardableResult` because a forced clear
    /// caches nothing.
    @discardableResult
    func setBadgeCount(_ count: Int) async -> Bool
    /// Clears the Dock badge **synchronously** — the write is issued before this call returns.
    ///
    /// `teardown()`'s only badge caller, and the reason this exists beside `setBadgeCount(_:)`.
    /// The Dock badge is process-global and a profile switch tears the outgoing model down and
    /// builds the incoming one in the same turn (`AppModel.activate` calls `tearDownExtensions()`
    /// and then `makeExtensions(store:)`). Reaching an `async` clear through an unstructured
    /// `Task` hands the ordering to the scheduler, which promises nothing about unstructured
    /// tasks on an actor: the outgoing profile's zero can land *after* the incoming profile's
    /// first count and sit there, because the new model's `lastBadge` cache then elides every
    /// write of that same count until it next moves. Issuing it here, with no suspension in
    /// between, is what makes "the clear happens before anything the next model writes" a
    /// property of the call order rather than of the scheduler.
    ///
    /// It answers nothing: a caller that has just torn itself down has nowhere to put an answer
    /// and nothing to retry with. A failure is logged by the implementation.
    func clearBadgeNow()
    /// Installs the click handler. Called once, after `onSelectSession` is set. Idempotent on
    /// `SystemNotificationCenter`; `FakeNotificationCenter` instead counts every call, so a test
    /// can hold a caller to calling it exactly once.
    ///
    /// The SDK requires the delegate to be set before the application finishes launching, or a
    /// tap that cold-launches the app is dropped: the operator clicks "TASK-07 — needs you" and
    /// the app opens on whatever session was last selected, not the one they tapped.
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
    /// Stages a delivery failure — what macOS rejecting `add(_:)` looks like to a caller. The
    /// request is still recorded, because the attempt was made; only the answer is `false`.
    var nextPostSucceeds = true
    /// Stages a rejected badge write — what `UNUserNotificationCenter.setBadgeCount` throwing
    /// looks like to a caller. `badge` is left alone, because a write macOS refused never
    /// reaches the Dock; only the attempt is counted.
    var nextBadgeWriteSucceeds = true
    /// Every `setBadgeCount` call, landed or rejected. `badge` on its own cannot tell a write
    /// that was elided from one that wrote the same number again, which is the whole subject of
    /// `NotificationsModel.writeBadge(_:)`.
    private(set) var badgeWrites = 0
    /// How many of those writes came through `clearBadgeNow()`. `badge == 0` alone cannot tell
    /// a clear that was issued synchronously from one a `Task` got round to eventually, and the
    /// ordering against the next profile's first write is the only thing that distinguishes
    /// them.
    private(set) var synchronousClears = 0
    /// Every `authorization()` read this centre has seen, parked or not. A test waiting for a
    /// read to reach the centre waits on this, never on the parked count, which falls again as
    /// reads are completed.
    private(set) var authorizationReads = 0
    /// Parks every `authorization()` read until the test completes it by index, so two reads can
    /// finish in the order the test chooses — the out-of-order case `NotificationsModel` guards
    /// with a request generation. Off by default: every other test wants the immediate answer.
    var suspendsAuthorizationReads = false
    /// One slot per parked read, in arrival order. A completed slot is emptied rather than
    /// removed, so an index keeps naming the read the test meant.
    private var parkedReads: [CheckedContinuation<NotificationAuthorization, Never>?] = []

    func start() { starts += 1 }

    func authorization() async -> NotificationAuthorization {
        authorizationReads += 1
        guard suspendsAuthorizationReads else { return nextAuthorization }
        return await withCheckedContinuation { continuation in
            parkedReads.append(continuation)
        }
    }

    /// Completes the `index`-th parked `authorization()` read — counted from this centre's first
    /// read — with `value`. A no-op for an index that never arrived or is already done, so a
    /// test cannot resume a continuation twice.
    func completeAuthorizationRead(_ index: Int, with value: NotificationAuthorization) {
        guard parkedReads.indices.contains(index), let continuation = parkedReads[index] else {
            return
        }
        parkedReads[index] = nil
        continuation.resume(returning: value)
    }

    func requestAuthorization() async -> NotificationAuthorization {
        authorizationRequests += 1
        return nextAuthorization
    }

    @discardableResult
    func post(_ request: NotificationRequest) async -> Bool {
        posted.append(request)
        return nextPostSucceeds
    }
    @discardableResult
    func setBadgeCount(_ count: Int) async -> Bool {
        badgeWrites += 1
        guard nextBadgeWriteSucceeds else { return false }
        badge = count
        return true
    }

    /// Lands before this call returns, exactly as the real one does — which is the whole point
    /// of the method, so the fake must not model it with a hop of its own. Counted in
    /// `badgeWrites` like any other write, and recorded separately so a test can tell a
    /// synchronous clear from an `await`ed `setBadgeCount(0)` that happens to write the same
    /// number. `nextBadgeWriteSucceeds` deliberately does not apply: the real method answers
    /// nothing and its caller has nothing to retry with, so there is no rejection to stage.
    func clearBadgeNow() {
        badgeWrites += 1
        synchronousClears += 1
        badge = 0
    }

    /// Test seam: pretend the operator clicked a banner for `sessionID`.
    ///
    /// Guarded on `starts > 0` because the real centre delivers nothing until `start()` installs
    /// the delegate — a model that sets `onSelectSession` but forgets to call `center.start()`
    /// must fail exactly the click tests it would otherwise pass.
    func deliverClick(sessionID: String) {
        guard starts > 0 else { return }
        onSelectSession?(sessionID)
    }

    /// Test seam for a full `NotificationRequest`. No-ops when `request.sessionID == nil`, the
    /// same way `ResponseDelegate.userNotificationCenter(_:didReceive:)` refuses to select a
    /// session when there is no session id in `userInfo` — the host-global usage warning must
    /// only open the app, never select a session.
    func deliverClick(for request: NotificationRequest) {
        guard let sessionID = request.sessionID else { return }
        deliverClick(sessionID: sessionID)
    }

    /// Clears the recording. Deliberately keeps `onSelectSession`, `nextAuthorization`,
    /// `nextPostSucceeds`, `nextBadgeWriteSucceeds` and `starts` — the fixture a test set up,
    /// not the evidence it is about to assert on.
    func reset() {
        posted.removeAll()
        badge = 0
        badgeWrites = 0
        synchronousClears = 0
        authorizationRequests = 0
        authorizationReads = 0
    }
}
