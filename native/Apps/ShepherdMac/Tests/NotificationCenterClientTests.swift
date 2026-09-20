import Foundation
import Testing

@testable import Shepherd

/// The system adapter itself is not unit-tested — it is a thin bridge to
/// `UNUserNotificationCenter`, and exercising it would pop the macOS permission alert, which the
/// global constraints forbid. What IS tested is the seam every other task codes against.
@MainActor
struct NotificationCenterClientTests {
    @Test func theFakeRecordsWhatItWasAskedToPost() async {
        let center = FakeNotificationCenter()
        await center.post(
            NotificationRequest(
                identifier: "n1", title: "t", body: "b", threadIdentifier: "s1",
                sessionID: "s1"))
        #expect(center.posted.count == 1)
        #expect(center.posted.first?.sessionID == "s1")
        #expect(center.posted.first?.threadIdentifier == "s1")
    }

    /// `post` answers the web's `sent`. The fake records the attempt either way — the request
    /// really was handed over — and only the answer changes, which is what lets a caller be
    /// held to latching state on delivery rather than on the call having returned.
    @Test func aStagedFailureIsRecordedAndReportedAsNotSent() async {
        let center = FakeNotificationCenter()
        let request = NotificationRequest.make(
            title: "t", body: "b", threadIdentifier: "s1", sessionID: "s1")
        let first = await center.post(request)
        #expect(first, "delivery succeeds unless a test says otherwise")

        center.nextPostSucceeds = false
        let second = await center.post(request)
        #expect(!second, "macOS rejecting `add(_:)` is what this stages")
        #expect(center.posted.count == 2, "the attempt is recorded either way")
    }

    /// `setBadgeCount` answers the same way `post` does. A rejected write counts as an attempt
    /// and leaves `badge` alone — a write macOS refused never reached the Dock — which is what
    /// lets `NotificationsModel` be held to retrying it instead of caching it as landed.
    @Test func aStagedBadgeWriteFailureIsCountedButNeverReachesTheDock() async {
        let center = FakeNotificationCenter()
        #expect(await center.setBadgeCount(2), "a write succeeds unless a test says otherwise")
        #expect(center.badge == 2)
        #expect(center.badgeWrites == 1)

        center.nextBadgeWriteSucceeds = false
        #expect(await center.setBadgeCount(5) == false)
        #expect(center.badge == 2, "the rejected count must not land")
        #expect(center.badgeWrites == 2, "the attempt is still counted")
    }

    @Test func theFakeRecordsTheBadgeAndTheAuthorizationRequest() async {
        let center = FakeNotificationCenter()
        center.nextAuthorization = .denied
        #expect(await center.requestAuthorization() == .denied)
        #expect(center.authorizationRequests == 1)

        await center.setBadgeCount(3)
        #expect(center.badge == 3)
    }

    @Test func aClickIsDeliveredToTheHandler() {
        let center = FakeNotificationCenter()
        center.start()
        var selected: String?
        center.onSelectSession = { selected = $0 }
        center.deliverClick(sessionID: "s9")
        #expect(selected == "s9")
    }

    @Test func aClickBeforeStartDoesNothing() {
        // The real centre delivers nothing until `start()` installs the delegate. A model that
        // sets `onSelectSession` but forgets `center.start()` must fail this, not pass it.
        let center = FakeNotificationCenter()
        var selected: String?
        center.onSelectSession = { selected = $0 }
        center.deliverClick(sessionID: "s9")
        #expect(selected == nil)
    }

    @Test func deliveringAHostGlobalRequestSelectsNoSession() {
        // The host-global usage warning has no session id. The real delegate's
        // `guard let id = info[...] as? String else { return }` refuses to select a session for
        // it; this is that behaviour made assertable on the fake.
        let center = FakeNotificationCenter()
        center.start()
        var selected: String?
        center.onSelectSession = { selected = $0 }
        let request = NotificationRequest.make(
            title: "t", body: "b", threadIdentifier: "host", sessionID: nil)
        center.deliverClick(for: request)
        #expect(selected == nil)
    }

    @Test func aRequestIdentifierIsUniquePerPost() {
        // Reusing an identifier replaces the banner already on screen. Two different sessions
        // going blocked must produce two banners, so the identifier carries a fresh UUID and the
        // GROUPING lives on threadIdentifier instead.
        let a = NotificationRequest.make(title: "t", body: "b", threadIdentifier: "s1", sessionID: "s1")
        let b = NotificationRequest.make(title: "t", body: "b", threadIdentifier: "s1", sessionID: "s1")
        #expect(a.identifier != b.identifier)
        #expect(a.threadIdentifier == b.threadIdentifier)
    }

    @Test func theAuthorizationQueryReportsWhateverWasStaged() async {
        let center = FakeNotificationCenter()
        #expect(await center.authorization() == .granted)
        center.nextAuthorization = .notDetermined
        #expect(await center.authorization() == .notDetermined)
        // Querying is not asking: only requestAuthorization() counts as a prompt.
        #expect(center.authorizationRequests == 0)
    }

    @Test func everyStartIsCounted() {
        // The system adapter makes `start()` idempotent — a second delegate registration is how a
        // tap gets delivered twice. The fake instead counts calls verbatim, so a model can be
        // held to starting the center exactly once rather than on every state change.
        let center = FakeNotificationCenter()
        #expect(!center.started)
        #expect(center.starts == 0)
        center.start()
        #expect(center.started)
        #expect(center.starts == 1)
        center.start()
        #expect(center.starts == 2)
    }

    @Test func resetClearsTheRecordingButKeepsTheHandler() async {
        let center = FakeNotificationCenter()
        center.start()
        var selected: String?
        center.onSelectSession = { selected = $0 }
        await center.post(NotificationRequest.make(title: "t", body: "b", threadIdentifier: "s1", sessionID: "s1"))
        await center.setBadgeCount(2)
        _ = await center.requestAuthorization()

        center.nextBadgeWriteSucceeds = false
        center.reset()
        #expect(center.posted.isEmpty)
        #expect(center.badge == 0)
        #expect(center.badgeWrites == 0)
        #expect(center.authorizationRequests == 0)
        #expect(
            center.nextBadgeWriteSucceeds == false,
            "staged answers are fixture, not evidence — `reset()` keeps them")

        center.deliverClick(sessionID: "s3")
        #expect(selected == "s3")
    }

    @Test func aClickWithNoHandlerIsHarmless() {
        let center = FakeNotificationCenter()
        center.start()
        center.deliverClick(sessionID: "s1")
        #expect(center.posted.isEmpty)
    }
}
