import Foundation
import ShepherdKit
import Testing
import os

@testable import Shepherd

@MainActor
struct NotificationGateTests {
    private let settings = NotificationSettings.default

    private func intent(_ kind: NotificationKind, _ id: String) -> NotificationIntent {
        NotificationIntent(kind: kind, sessionID: id, subject: id)
    }

    /// `allows` is `mutating` — a positive answer stamps the cooldown — and the `#expect` macro
    /// captures what it is handed immutably, so every call is bound to a `let` first. That is
    /// also the honest shape: each line below really does advance the gate's state.
    @Test func afocusedWindowStopsEverything() {
        var gate = NotificationGate()
        let allowed = gate.allows(
            intent(.blocked, "s1"), at: 0, settings: settings, windowFocused: true,
            authorized: true)
        #expect(!allowed, "the list in front of the operator already says it")
    }

    @Test func aDeniedAuthorizationStopsEverything() {
        var gate = NotificationGate()
        let allowed = gate.allows(
            intent(.blocked, "s1"), at: 0, settings: settings, windowFocused: false,
            authorized: false)
        #expect(!allowed)
    }

    @Test func aMutedCategoryStopsItsKindsButNotReady() {
        var gate = NotificationGate()
        let muted = settings.setting(.agent, to: false)
        let done = gate.allows(
            intent(.done, "s1"), at: 0, settings: muted, windowFocused: false, authorized: true)
        #expect(!done)
        // `if (input.kind !== "ready" && !row.cats[category]) continue;` — ready always gets out.
        let ready = gate.allows(
            intent(.ready, "s1"), at: 0, settings: muted, windowFocused: false, authorized: true)
        #expect(ready)
    }

    @Test func theMasterSwitchAlsoSilencesReady() {
        var gate = NotificationGate()
        let off = settings.settingEnabled(false)
        let allowed = gate.allows(
            intent(.ready, "s1"), at: 0, settings: off, windowFocused: false, authorized: true)
        #expect(!allowed, "a profile the operator turned off is off, with no exceptions")
    }

    @Test func aRepeatWithinTheCooldownIsDropped() {
        var gate = NotificationGate()
        let first = gate.allows(
            intent(.done, "s1"), at: 0, settings: settings, windowFocused: false, authorized: true)
        #expect(first)
        let inside = gate.allows(
            intent(.done, "s1"), at: NotificationGate.defaultCooldown - 1, settings: settings,
            windowFocused: false, authorized: true)
        #expect(!inside)
        let after = gate.allows(
            intent(.done, "s1"), at: NotificationGate.defaultCooldown, settings: settings,
            windowFocused: false, authorized: true)
        #expect(after)
    }

    /// The optimistic stamp, from the gate's side: two frames carrying the *same* timestamp —
    /// what two events arriving back to back while the first post is still awaiting look like —
    /// produce one `true`. The web serialises those with an `inFlight` flag this port does not
    /// have, so stamping before the caller's `await` is the whole mechanism.
    @Test func twoFramesAtTheSameInstantCollapseToOne() {
        var gate = NotificationGate()
        let first = gate.allows(
            intent(.blocked, "s1"), at: 42, settings: settings, windowFocused: false,
            authorized: true)
        #expect(first)
        let second = gate.allows(
            intent(.blocked, "s1"), at: 42, settings: settings, windowFocused: false,
            authorized: true)
        #expect(!second)
    }

    @Test func distinctKindsAndSessionsNeverCollapse() {
        var gate = NotificationGate()
        let done1 = gate.allows(
            intent(.done, "s1"), at: 0, settings: settings, windowFocused: false, authorized: true)
        #expect(done1)
        let blocked1 = gate.allows(
            intent(.blocked, "s1"), at: 1, settings: settings, windowFocused: false,
            authorized: true)
        #expect(blocked1)
        let done2 = gate.allows(
            intent(.done, "s2"), at: 2, settings: settings, windowFocused: false, authorized: true)
        #expect(done2)
    }

    @Test func aSuppressedIntentDoesNotStartTheCooldownClock() {
        // PushService only stamps `lastNotified` on a successful send, so a notification the
        // operator never saw must not swallow the next one.
        var gate = NotificationGate()
        let suppressed = gate.allows(
            intent(.done, "s1"), at: 0, settings: settings, windowFocused: true, authorized: true)
        #expect(!suppressed)
        let next = gate.allows(
            intent(.done, "s1"), at: 1, settings: settings, windowFocused: false, authorized: true)
        #expect(next)
    }

    /// `init(cooldown: 0)` disables the de-duplication outright, which is the seam a test that
    /// needs two consecutive posts uses. Kept honest here so the parameter is not dead code.
    @Test func aZeroCooldownNeverDrops() {
        var gate = NotificationGate(cooldown: 0)
        let first = gate.allows(
            intent(.done, "s1"), at: 0, settings: settings, windowFocused: false, authorized: true)
        #expect(first)
        let second = gate.allows(
            intent(.done, "s1"), at: 0, settings: settings, windowFocused: false, authorized: true)
        #expect(second)
    }
}

@MainActor
struct NotificationsModelTests {
    /// Milliseconds since the epoch, the unit every clock in this stream carries.
    private static let nowMs = 1_800_000_000_000
    /// Five hours past `nowMs`: a `usage:limits` window that does not elapse during a test.
    private static let openWindow = nowMs + 5 * 60 * 60 * 1_000

    private func scratch() -> UserDefaults {
        UserDefaults(suiteName: "run.shepherd.mac.notifymodel.\(UUID().uuidString)")!
    }

    /// `async` because the test-seam `init` does not read the authorization state — only the
    /// `init(store:app:)` path does, from a task — so every suite that expects a banner has to
    /// resolve it first, exactly as the app does at launch.
    private func model(
        center: FakeNotificationCenter,
        selected: @escaping @MainActor (String) -> Void = { _ in },
        clock: @escaping @Sendable () -> Int = { 0 }
    ) async -> NotificationsModel {
        let m = NotificationsModel(
            center: center,
            settingsStore: NotificationSettingsStore(defaults: scratch()),
            profileID: UUID(),
            now: clock,
            subjectFor: { $0 == "s1" ? "TASK-07" : nil },
            select: selected)
        await m.requestAuthorization()
        return m
    }

    /// A clock that moves five minutes — comfortably past the 120 s cooldown — every time it is
    /// read. A frozen clock would make the usage suite pass for the wrong reason twice over: the
    /// cooldown would swallow the second frame whether or not the window was latched, and a
    /// latched `warnedUntil` would sit forever in the future of a `now()` of zero.
    private func advancingClock(
        from start: Int = nowMs, step: Int = 300_000
    ) -> @Sendable () -> Int {
        let state = OSAllocatedUnfairLock(initialState: start)
        return { state.withLock { (value: inout Int) -> Int in
            value += step
            return value
        } }
    }

    private func usage(pct: Double, resetAt: Int = openWindow) -> ServerEvent {
        .usageLimits(
            UsageLimits(
                session5h: .init(pct: pct, resetAt: resetAt),
                week: nil, perModelWeek: [], credits: nil,
                stale: false, calibratedAt: nil, subscriptionOnly: false))
    }

    @Test func aBlockedFramePostsABannerNamingTheSession() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        let block = BlockReason(shape: .init(value1: .stall), options: [], tail: [])
        await m.handle(.sessionBlock(.init(id: "s1", block: block)))

        #expect(center.posted.count == 1)
        #expect(center.posted.first?.title == L.t("native_notify_blocked_title", "TASK-07"))
        #expect(center.posted.first?.body == L.t("hold_blocked_stall"))
        #expect(center.posted.first?.sessionID == "s1")
    }

    @Test func nothingIsPostedWhileTheWindowIsFocused() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(true)
        await m.handle(.sessionStatus(.init(id: "s1", status: SessionStatus(known: .done))))
        #expect(center.posted.isEmpty)
    }

    /// The cooldown, end to end: two `done` frames one instant apart are one banner, because the
    /// gate stamps its table synchronously — before the `await` on the post — rather than after
    /// the post resolves.
    @Test func aSecondFrameInsideTheCooldownPostsNothing() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        for _ in 0..<2 {
            await m.handle(.sessionStatus(.init(id: "s1", status: SessionStatus(known: .done))))
        }
        #expect(center.posted.count == 1)
    }

    /// A muted `agent` category silences `done` and still lets `ready` out — the whole point of
    /// `NotificationKind.bypassesCategoryFilter`, asserted through the model so the gate's
    /// composition (`enabled && (bypass || allows(category))`) is covered where it is used.
    @Test func aMutedAgentCategoryStillLetsReadyThrough() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        m.save(NotificationSettings.default.setting(.agent, to: false))

        await m.handle(.sessionStatus(.init(id: "s1", status: SessionStatus(known: .done))))
        #expect(center.posted.isEmpty, "a muted category silences its own kinds")

        await m.handle(.sessionReady(.init(id: "s1", ready: true)))
        #expect(center.posted.count == 1)
        #expect(center.posted.first?.title == L.t("native_notify_ready_title", "TASK-07"))
    }

    /// The usage latch: `if (sent) store.setSetting(USAGE_WARNED_KEY, …)`.
    ///
    /// The server re-sends `usage:limits` roughly every 30 s for the rest of a 5-hour window, so
    /// the *only* thing standing between the operator and ~150 identical banners is the model
    /// confirming the post to the trigger. The clock advances past the cooldown between frames
    /// on purpose: with a frozen clock this test would pass without the confirmation.
    @Test func theUsageWarningFiresOncePerWindowEvenAsFramesKeepArriving() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center, clock: advancingClock())
        await m.setWindowFocused(false)

        await m.handle(usage(pct: 83))
        await m.handle(usage(pct: 91))

        #expect(center.posted.count == 1, "one window, one banner")
        #expect(center.posted.first?.title == L.t("native_notify_usage_title", "83"))
    }

    /// The other half of the latch: a warning the gate refused is not a warning the operator
    /// saw, so the window must still be open when the next frame arrives.
    @Test func aSuppressedUsageWarningIsRetriedOnTheNextFrame() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center, clock: advancingClock())
        await m.setWindowFocused(true)
        await m.handle(usage(pct: 83))
        #expect(center.posted.isEmpty)

        await m.setWindowFocused(false)
        await m.handle(usage(pct: 84))
        #expect(center.posted.count == 1)
        #expect(center.posted.first?.title == L.t("native_notify_usage_title", "84"))
    }

    @Test func aClickSelectsTheSession() async {
        let center = FakeNotificationCenter()
        var selected: String?
        _ = await model(center: center, selected: { selected = $0 })
        center.deliverClick(sessionID: "s9")
        #expect(selected == "s9")
        #expect(center.started, "the click handler must be installed at init")
    }

    @Test func theBadgeCountsBlockedAndReadySessionsAndClearsWhenFocused() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        var blocked = PreviewData.session(id: "a", status: SessionStatus(known: .blocked))
        var ready = PreviewData.session(id: "b", status: SessionStatus(known: .idle))
        ready.readyToMerge = true
        let busy = PreviewData.session(id: "c", status: SessionStatus(known: .running))
        let archived = PreviewData.session(id: "d", status: SessionStatus(known: .archived))
        blocked.readyToMerge = false

        await m.setWindowFocused(false)
        await m.updateBadge(sessions: [blocked, ready, busy, archived])
        #expect(center.badge == 2)

        m.extraAttention = ["c"]
        await m.updateBadge(sessions: [blocked, ready, busy, archived])
        #expect(center.badge == 3, "the S2 seam adds ci-red sessions once it is assigned")

        await m.setWindowFocused(true)
        #expect(center.badge == 0, "focusing the window clears the badge, as the web tab does")
    }

    @Test func anArchivedSessionNeverCounts() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        var archived = PreviewData.session(id: "d", status: SessionStatus(known: .archived))
        archived.readyToMerge = true
        await m.setWindowFocused(false)
        await m.updateBadge(sessions: [archived])
        #expect(center.badge == 0)
    }

    @Test func aSessionCountedTwiceIsCountedOnce() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        var both = PreviewData.session(id: "a", status: SessionStatus(known: .blocked))
        both.readyToMerge = true
        await m.setWindowFocused(false)
        await m.updateBadge(sessions: [both])
        #expect(center.badge == 1)
    }

    @Test func settingsPersistAndTakeEffectImmediately() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        m.save(NotificationSettings.default.settingEnabled(false))
        await m.handle(.sessionStatus(.init(id: "s1", status: SessionStatus(known: .done))))
        #expect(center.posted.isEmpty)
    }

    @Test func aDeniedAuthorizationIsRecordedAndNothingIsPosted() async {
        let center = FakeNotificationCenter()
        center.nextAuthorization = .denied
        let m = await model(center: center)
        #expect(m.authorization == .denied)
        await m.setWindowFocused(false)
        await m.handle(.sessionReady(.init(id: "s1", ready: true)))
        #expect(center.posted.isEmpty)
    }

    @Test func teardownEndsTheSubscriptionAndClearsTheBadge() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        await m.updateBadge(
            sessions: [PreviewData.session(id: "a", status: SessionStatus(known: .blocked))])
        #expect(center.badge == 1)
        m.teardown()
        #expect(!m.isSubscribed)
        // `teardown()` is synchronous but the badge clear is a main-actor `Task`, so give the
        // run loop one turn before asserting on it.
        await Task.yield()
        #expect(center.badge == 0, "a profile switch must not leave the old server's count up")
    }
}

/// The install point, driven through a real `AppModel` — which is also the only place the
/// `init(store:app:)` branch runs, and therefore the proof that an isolated launch (which every
/// test is) builds a `FakeNotificationCenter` and never reaches `UNUserNotificationCenter`.
@MainActor
@Suite(.serialized)
struct NotificationsStreamTests {
    private func makeModel() -> AppModel {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
    }

    @Test func installRegistersTheModelAndIsIdempotent() async throws {
        let app = makeModel()
        NotificationsStream.install(app)
        NotificationsStream.install(app)
        #expect(app.extension(NotificationsModel.self) == nil, "nothing is live before a store")

        let profile = try app.addRemoteProfile(
            name: "notify", address: "https://notify.example.ts.net")
        await app.activate(profile)
        let live = try #require(app.extension(NotificationsModel.self))
        #expect(live.isSubscribed, "the event tap is running")

        app.teardown()
        #expect(!live.isSubscribed)
        #expect(app.extension(NotificationsModel.self) == nil)
    }
}
