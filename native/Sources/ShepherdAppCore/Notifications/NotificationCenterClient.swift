import Foundation

/// One banner to post. Not a server payload — it never crosses the wire — so it is an ordinary
/// value type and the "no hand-written Codable" rule does not apply.
public struct NotificationRequest: Equatable, Sendable {
    /// Unique per post. `UNUserNotificationCenter` replaces a pending request with the same
    /// identifier, so reusing one would let a second session's banner eat the first's.
    public let identifier: String
    public let title: String
    public let body: String
    /// Groups a session's banners in Notification Centre — the macOS analogue of the web
    /// service worker's `tag`.
    public let threadIdentifier: String
    /// What a click selects. `nil` for the host-global usage warning, which just opens the app.
    public let sessionID: String?

    static func make(
        title: String, body: String, threadIdentifier: String, sessionID: String?
    ) -> NotificationRequest {
        NotificationRequest(
            identifier: UUID().uuidString, title: title, body: body,
            threadIdentifier: threadIdentifier, sessionID: sessionID)
    }
}

/// What macOS currently allows.
public enum NotificationAuthorization: Equatable, Sendable {
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
public protocol NotificationCenterClient: AnyObject {
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

/// Records instead of posting. Used by every test, by previews, and — deliberately — by an
/// isolated launch, so an automated run never asks macOS for permission. It references nothing
/// from `UserNotifications`.
@MainActor
public final class FakeNotificationCenter: NotificationCenterClient {
    public init() {}

    public var onSelectSession: ((String) -> Void)?
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

    public func start() { starts += 1 }

    public func authorization() async -> NotificationAuthorization {
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

    public func requestAuthorization() async -> NotificationAuthorization {
        authorizationRequests += 1
        return nextAuthorization
    }

    @discardableResult
    public func post(_ request: NotificationRequest) async -> Bool {
        posted.append(request)
        return nextPostSucceeds
    }
    @discardableResult
    public func setBadgeCount(_ count: Int) async -> Bool {
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
    public func clearBadgeNow() {
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
