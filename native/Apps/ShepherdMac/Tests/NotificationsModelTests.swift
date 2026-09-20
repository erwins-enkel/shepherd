import AppKit
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

        // `extraAttention`'s `didSet` refreshes the badge on a `Task` hop of its own, from the
        // model's own `badgeSource()` — which holds nothing in this seam. Let it land before
        // the explicit `updateBadge` below, or the two race and the refresh can overwrite the
        // count this test is asserting on. The `extraAttention` suite yields for the same
        // reason.
        m.extraAttention = ["c"]
        await Task.yield()
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

    /// `UNUserNotificationCenter.delegate` is weak and `teardown()` keeps the centre alive to
    /// clear the badge, so a handler left installed is a live closure over the *outgoing*
    /// profile: a banner for profile A clicked after the operator switched to B would select
    /// A's session id against B's model, and the list jumps to nothing selected.
    @Test func aClickAfterTeardownSelectsNothing() async {
        let center = FakeNotificationCenter()
        var selected: String?
        let m = await model(center: center, selected: { selected = $0 })
        center.deliverClick(sessionID: "s1")
        #expect(selected == "s1", "the handler is live before the teardown")

        selected = nil
        m.teardown()
        await Task.yield()
        center.deliverClick(sessionID: "s9")
        #expect(selected == nil, "a torn-down model no longer answers a banner click")
    }

    /// The badge is written per *change*, not per frame. `handle(_:)` refreshes it for every
    /// frame the tap delivers, including the high-rate ones this model ignores; the tap is
    /// strictly serial and buffers only 64 frames, so an XPC round trip per ignored frame is
    /// how a burst of activity drops the one `session:block` a banner depended on.
    @Test func anUnchangedBadgeIsWrittenOnlyOnce() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        let blocked = PreviewData.session(id: "a", status: SessionStatus(known: .blocked))
        await m.updateBadge(sessions: [blocked])
        #expect(center.badge == 1)

        // Cleared behind the model's back: a second write of the same count would put it back.
        center.reset()
        for _ in 0..<5 { await m.updateBadge(sessions: [blocked]) }
        #expect(center.badge == 0, "the same count is never written twice")

        var ready = PreviewData.session(id: "b", status: SessionStatus(known: .idle))
        ready.readyToMerge = true
        await m.updateBadge(sessions: [blocked, ready])
        #expect(center.badge == 2, "a count that changed still goes through")
    }

    /// The other half of the elision: a clear is forced, because the Dock badge is global and
    /// what is on it may not be what this model last wrote.
    @Test func aClearIsNeverElided() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        await m.updateBadge(sessions: [])
        #expect(center.badge == 0, "nothing needs the operator, and zero is now the last write")

        await center.setBadgeCount(4)
        await m.setWindowFocused(true)
        #expect(center.badge == 0, "focus clears the badge whatever this model last wrote")

        await center.setBadgeCount(4)
        m.teardown()
        await Task.yield()
        #expect(center.badge == 0, "and so does a teardown")
    }

    /// `if (sent) …`, the whole point of the seam returning a `Bool`: a banner macOS threw away
    /// is not a banner the operator saw, so the 5-hour window must still be open when the next
    /// `usage:limits` frame arrives. Latching on a rejection would silence the rest of the
    /// window with nothing delivered.
    @Test func aRejectedBannerDoesNotLatchTheUsageWindow() async {
        let center = FakeNotificationCenter()
        center.nextPostSucceeds = false
        let m = await model(center: center, clock: advancingClock())
        await m.setWindowFocused(false)

        await m.handle(usage(pct: 83))
        #expect(center.posted.count == 1, "the attempt was made")

        center.nextPostSucceeds = true
        await m.handle(usage(pct: 84))
        #expect(center.posted.count == 2, "a rejected delivery leaves the window open")
        #expect(center.posted.last?.title == L.t("native_notify_usage_title", "84"))
    }

    /// The settings-panel half of the stale-model bug: a toggle flipped on a panel whose model
    /// was already torn down (the operator switched profiles without closing the panel) must
    /// not reach the store, and must not even change the in-memory `settings` the panel reads
    /// back — a `save` that "succeeded" locally but never persisted would be its own, quieter
    /// version of the same bug.
    @Test func aSaveAfterTeardownDoesNotReachTheStoreOrTheModel() async {
        let center = FakeNotificationCenter()
        let suite = scratch()
        let profileID = UUID()
        let store = NotificationSettingsStore(defaults: suite)
        let m = NotificationsModel(
            center: center, settingsStore: store, profileID: profileID,
            now: { 0 }, subjectFor: { _ in nil }, select: { _ in })
        await m.requestAuthorization()
        let before = m.settings
        m.teardown()

        m.save(before.settingEnabled(false))

        #expect(m.settings == before, "a torn-down model must not update its own settings")
        #expect(
            store.load(for: profileID) == .default,
            "and must not persist the write to the profile it used to belong to")
    }

    /// The same guard for the panel's "Allow notifications" button, which also calls into the
    /// model after it may have been torn down.
    @Test func requestAuthorizationAfterTeardownDoesNotAskAgain() async {
        let center = FakeNotificationCenter()
        center.nextAuthorization = .denied
        let m = await model(center: center)
        #expect(m.authorization == .denied)
        m.teardown()

        center.nextAuthorization = .granted
        await m.requestAuthorization()

        #expect(m.authorization == .denied, "a torn-down model does not ask macOS again")
    }

    /// The focus observer's hop can resume after a profile switch. `setWindowFocused` is a
    /// no-op once torn down, so it cannot write the outgoing centre's badge over the count the
    /// incoming profile just set — the Dock badge is one badge for the whole app.
    @Test func aFocusChangeAfterTeardownChangesNothing() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        m.teardown()
        await Task.yield()

        // Stand in for the count the incoming profile has already put on the Dock.
        await center.setBadgeCount(6)
        await m.setWindowFocused(true)
        #expect(!m.windowFocused, "a torn-down model records no focus")
        #expect(center.badge == 6, "and writes nothing over the next profile's badge")
    }

    /// `handle(_:)` cannot consult the activation generation, so cancellation is what stops it
    /// — and it has to stop the *whole* frame. The guard used to sit after the post, inside the
    /// branch the gate allowed, so the two cases that reach neither (a frame carrying no intent
    /// at all, and one the gate refused) still fell through to the badge refresh at the end.
    /// A tap is cancelled by `teardown()`, i.e. by a profile switch, and the Dock badge is
    /// global: that refresh writes the outgoing profile's count over the incoming one's.
    @Test func aCancelledTapRefreshesNothingNotEvenForAFrameThatPostsNothing() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        await m.updateBadge(
            sessions: [PreviewData.session(id: "a", status: SessionStatus(known: .blocked))])
        #expect(center.badge == 1)

        // `session:activity` — one of the high-rate frames this model ignores. It produces no
        // intent, so the old guard was never reached and `refreshBadge()` ran anyway, deriving
        // 0 from this seam's empty badge source.
        let quiet = Task { @MainActor in
            await m.handle(.unknown(name: "session:activity", payload: nil))
        }
        // Cancelled before the body can start: nothing in `handle` suspends until `task.value`.
        quiet.cancel()
        await quiet.value
        #expect(center.badge == 1, "a cancelled tap refreshes nothing")

        // And the branch that would have posted is stopped too.
        let block = BlockReason(shape: .init(value1: .stall), options: [], tail: [])
        let loud = Task { @MainActor in
            await m.handle(.sessionBlock(.init(id: "s1", block: block)))
        }
        loud.cancel()
        await loud.value
        #expect(center.posted.isEmpty, "a cancelled tap posts nothing either")
        #expect(center.badge == 1)

        // Uncancelled, the same frame does both — the guard stops a cancelled tap, not the tap.
        await m.handle(.sessionBlock(.init(id: "s2", block: block)))
        #expect(center.posted.count == 1, "an uncancelled tap still posts")
        #expect(center.badge == 0, "and still refreshes the badge from the store")
    }

    /// The S0-int seam, held to two things: it may only count sessions that exist, and
    /// assigning it must show up on the Dock without waiting for the next frame.
    @Test func extraAttentionCountsOnlyLiveSessionsAndRefreshesTheBadgeItself() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        let busy = PreviewData.session(id: "c", status: SessionStatus(known: .running))
        let archived = PreviewData.session(id: "d", status: SessionStatus(known: .archived))

        m.extraAttention = ["ghost", "d"]
        await Task.yield()
        await m.updateBadge(sessions: [busy, archived])
        #expect(
            center.badge == 0,
            "an id no live session carries is a phantom the operator cannot clear")

        m.extraAttention = ["c"]
        await Task.yield()
        await m.updateBadge(sessions: [busy, archived])
        #expect(center.badge == 1, "a live session the integration lane flagged does count")

        // The refresh, on its own: the model's own badge source holds no sessions, so dropping
        // the seam takes the count back to zero with no frame in between.
        m.extraAttention = []
        await Task.yield()
        #expect(center.badge == 0, "assigning the seam refreshes the badge itself")
    }

    /// The de-duplication has to hold in the state the operator is actually in most of the day:
    /// window in front, several agents running, a `session:activity` / `session:claude-alive` /
    /// `session:git` frame every few hundred milliseconds. The focused branch used to call
    /// `clearBadge()`, which drops `lastBadge` before writing — so the elision could never fire
    /// and every one of those frames cost an XPC round trip to `notificationd`. The serial tap
    /// parks on that round trip, `bufferingNewest(64)` overflows, and the frame it drops can be
    /// the one `session:block` the banner depended on — silently, because the badge still looks
    /// right.
    @Test func aFocusedWindowWritesTheZeroBadgeOnceNotOncePerFrame() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        let blocked = PreviewData.session(id: "a", status: SessionStatus(known: .blocked))

        await m.setWindowFocused(false)
        await m.updateBadge(sessions: [blocked])
        #expect(center.badge == 1)

        // Coming forward is a transition, and a transition still forces the write through.
        await m.setWindowFocused(true)
        #expect(center.badge == 0, "focusing the window still clears the badge")

        // A count on the Dock that this model did not write, put there behind its back. Every
        // further focused refresh derives the same zero it already wrote, so none of them may
        // reach the centre — if one did, the 7 would be gone.
        await center.setBadgeCount(7)
        for _ in 0..<5 { await m.updateBadge(sessions: [blocked]) }
        #expect(center.badge == 7, "a focused refresh writes nothing once the zero is out")
    }

    /// `setWindowFocused` resumes after `store.setActive` on an actor hop, and an actor makes no
    /// FIFO promise: two transitions in flight can resume in the opposite order from the one
    /// they arrived in. The synchronous assignment decides which transition really happened, so
    /// the badge branch has to read that live value rather than the one this call captured —
    /// otherwise the loser writes last, and `writeBadge`'s elision makes it stick until the
    /// derived count moves.
    ///
    /// The interleave itself cannot be forced here: this seam has no store, so
    /// `await store?.setActive(focused)` does not suspend at all. What the test pins is the
    /// invariant that holds for *every* resumption order once the branch reads the live value —
    /// the badge always agrees with the focus the model records.
    @Test func theBadgeFollowsTheLiveFocusValueNotTheOneTheCallCaptured() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)

        await m.setWindowFocused(false)
        await m.updateBadge(sessions: [])
        #expect(center.badge == 0, "zero is now the last count this model wrote")

        // A count on the Dock this model did not write. It is what tells the two branches
        // apart: the focus-in clear is forced through and wipes it, while an unfocused refresh
        // derives the same zero it already wrote and is elided, leaving it alone.
        await center.setBadgeCount(7)

        // Two transitions in flight at once, free to resume in either order.
        async let resigned: Void = m.setWindowFocused(false)
        async let activated: Void = m.setWindowFocused(true)
        _ = await (resigned, activated)
        for _ in 0..<5 { await Task.yield() }

        #expect(
            center.badge == (m.windowFocused ? 0 : 7),
            "whichever transition landed last is the one the badge branch followed")
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

    /// The launch task asks macOS for the authorization state and only then forwards focus. It
    /// must forward the *live* value: an operator who switches away during that await has the
    /// observer's answer in `windowFocused` already, and replaying the sample taken before the
    /// await would leave notifications suppressed — and presence active — until the next
    /// transition.
    @Test func aFocusChangeDuringTheLaunchTaskSurvives() async throws {
        let app = makeModel()
        NotificationsStream.install(app)
        let profile = try app.addRemoteProfile(
            name: "notify-focus", address: "https://notify.example.ts.net")
        await app.activate(profile)
        let live = try #require(app.extension(NotificationsModel.self))

        // What the activation observer does while the launch task is still in its await.
        let flipped = !live.windowFocused
        await live.setWindowFocused(flipped)
        for _ in 0..<5 { await Task.yield() }
        #expect(live.windowFocused == flipped, "the launch task must not replay a stale sample")

        app.teardown()
    }
}

@MainActor
@Suite(.serialized)
struct NotificationSettingsViewTests {
    init() { NotificationSettingsWindow.reset() }

    /// A throwaway suite *and* an in-memory credential store. `AppModel.init` defaults
    /// `credentials` to `KeychainCredentialStore()`, which is exactly the unattended-run stall
    /// this plan's "No Keychain prompts" constraint exists to prevent; every existing app test
    /// passes the in-memory store for the same reason.
    private func scratchApp() -> AppModel {
        AppModel(
            defaults: UserDefaults(
                suiteName: "run.shepherd.mac.notifyview.\(UUID().uuidString)")!,
            credentials: InMemoryCredentialStore())
    }

    @Test func theMenuItemIsInstalledOnceHoweverOftenInstallRuns() {
        let app = scratchApp()
        #expect(!NotificationSettingsWindow.menuItemInstalled)
        NotificationSettingsWindow.installMenuItem(app)
        NotificationSettingsWindow.installMenuItem(app)
        #expect(NotificationSettingsWindow.menuItemInstalled)
    }

    @Test func installingTheStreamRegistersOneExtension() {
        let app = scratchApp()
        NotificationsStream.install(app)
        NotificationsStream.install(app)
        #expect(app.extensionFactories.count == 1)
    }

    @Test func theViewModelReportsWhatThePanelMustSay() {
        #expect(
            NotificationSettingsView.permissionNote(for: .denied)
                == L.t("native_notify_settings_permission_denied"))
        #expect(NotificationSettingsView.permissionNote(for: .granted) == nil)
        #expect(
            NotificationSettingsView.permissionNote(for: .notDetermined) == nil,
            "not-yet-asked shows the button, not the warning")
        #expect(NotificationSettingsView.showsAskButton(for: .notDetermined))
        #expect(!NotificationSettingsView.showsAskButton(for: .granted))
        #expect(!NotificationSettingsView.showsAskButton(for: .denied))
    }

    /// The other half of the stale-panel bug: an operator who switches the active profile from
    /// the main window, without closing an already-open panel, must not go on seeing — or
    /// writing to — the profile the panel was opened for. Closing (over re-hosting) is asserted
    /// indirectly here: a closed panel cannot still be presenting a stale name at all.
    @Test func theWindowClosesWhenTheActiveProfileChanges() async throws {
        let app = scratchApp()
        let first = try app.addRemoteProfile(
            name: "panel-first", address: "https://panel-first.example.ts.net")
        await app.activate(first)
        NotificationSettingsWindow.show(app)

        let second = try app.addRemoteProfile(
            name: "panel-second", address: "https://panel-second.example.ts.net")
        await app.activate(second)
        for _ in 0..<5 { await Task.yield() }

        #expect(
            NotificationSettingsWindow.isOpen == false,
            "a stale panel must not keep showing the previous profile's name or accept toggles")

        app.teardown()
    }

    /// `reset()` must remove the item and separator `installMenuItem` inserted, not merely clear
    /// the flag that gates a second insert — the flag alone lets a second test's `installMenuItem`
    /// add a genuine duplicate, since the guard only stops re-insertion while the flag is still
    /// `true`. Inspecting `NSApp.mainMenu` is what actually proves the regression is absent; the
    /// suite's `init()` already calls `reset()` first, so this starts from zero items.
    @Test func resetRemovesTheMenuItemAndSeparatorItInserted() {
        let app = scratchApp()
        NotificationSettingsWindow.installMenuItem(app)
        NotificationSettingsWindow.installMenuItem(app)

        #expect(
            notificationsMenuItemCount() == 1,
            "a second install call must not add a genuine duplicate")

        NotificationSettingsWindow.reset()

        #expect(
            notificationsMenuItemCount() == 0,
            "reset() must remove the item it inserted, not just clear the Boolean")
    }

    private func notificationsMenuItemCount() -> Int {
        guard let appMenu = NSApp?.mainMenu?.items.first?.submenu else { return 0 }
        let title = L.t("native_notify_settings_menu_item")
        return appMenu.items.filter { $0.title == title }.count
    }
}
