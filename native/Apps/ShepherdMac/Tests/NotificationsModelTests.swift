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

    /// `allows` asks, `posted` stamps. Every sequence below spells both out, because that is the
    /// contract the caller has to honour: post what `allows` said yes to, then tell the gate
    /// whether it really went out.
    @Test func afocusedWindowStopsEverything() {
        let gate = NotificationGate()
        let allowed = gate.allows(
            intent(.blocked, "s1"), at: 0, settings: settings, windowFocused: true,
            authorized: true)
        #expect(!allowed, "the list in front of the operator already says it")
    }

    @Test func aDeniedAuthorizationStopsEverything() {
        let gate = NotificationGate()
        let allowed = gate.allows(
            intent(.blocked, "s1"), at: 0, settings: settings, windowFocused: false,
            authorized: false)
        #expect(!allowed)
    }

    /// The web exempts `ready` from the category filter because its `ready` push only fires in
    /// reduced-push mode; this port fires it off the operator's own manual ready-to-merge
    /// toggle, so nothing is exempt. A muted category is muted.
    @Test func aMutedCategoryStopsEveryKindItOwnsIncludingReady() {
        let gate = NotificationGate()
        let muted = settings.setting(.agent, to: false)
        let done = gate.allows(
            intent(.done, "s1"), at: 0, settings: muted, windowFocused: false, authorized: true)
        #expect(!done)
        let ready = gate.allows(
            intent(.ready, "s1"), at: 0, settings: muted, windowFocused: false, authorized: true)
        #expect(!ready, "no kind walks past a category the operator turned off")
        // The *other* category is untouched: muting "agent" is not muting everything.
        let ci = gate.allows(
            intent(.mergeError, "s1"), at: 0, settings: muted, windowFocused: false,
            authorized: true)
        #expect(ci)
    }

    @Test func theMasterSwitchSilencesEveryKind() {
        let gate = NotificationGate()
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
        gate.posted(intent(.done, "s1"), at: 0)
        let inside = gate.allows(
            intent(.done, "s1"), at: NotificationGate.defaultCooldown - 1, settings: settings,
            windowFocused: false, authorized: true)
        #expect(!inside)
        let after = gate.allows(
            intent(.done, "s1"), at: NotificationGate.defaultCooldown, settings: settings,
            windowFocused: false, authorized: true)
        #expect(after)
    }

    /// Two frames carrying the *same* timestamp collapse to one, because the first one's
    /// delivery is stamped before the second is asked. Nothing has to be optimistic about it:
    /// `NotificationsModel.subscribe` drives `handle(_:)` from a strictly serial `for await`
    /// loop, so the second frame cannot be asked until the first has been posted and stamped.
    @Test func aSecondFrameAtTheSameInstantIsDroppedOnceTheFirstWasDelivered() {
        var gate = NotificationGate()
        let first = gate.allows(
            intent(.blocked, "s1"), at: 42, settings: settings, windowFocused: false,
            authorized: true)
        #expect(first)
        gate.posted(intent(.blocked, "s1"), at: 42)
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
        gate.posted(intent(.done, "s1"), at: 0)
        let blocked1 = gate.allows(
            intent(.blocked, "s1"), at: 1, settings: settings, windowFocused: false,
            authorized: true)
        #expect(blocked1)
        gate.posted(intent(.blocked, "s1"), at: 1)
        let done2 = gate.allows(
            intent(.done, "s2"), at: 2, settings: settings, windowFocused: false, authorized: true)
        #expect(done2)
    }

    /// Asking does not start the clock. A banner `notificationd` threw away was never seen, so
    /// the next frame under the same key has to get through — `if (sent && cooldownMs > 0)
    /// this.lastNotified.set(key, t)` in `PushService.notify`. Without the `posted` split, the
    /// second `allows` below is refused and a blocked agent goes unannounced for 120 s.
    @Test func allowingAnIntentDoesNotStartTheCooldown() {
        var gate = NotificationGate()
        let first = gate.allows(
            intent(.blocked, "s1"), at: 0, settings: settings, windowFocused: false,
            authorized: true)
        #expect(first)
        // No `posted` — this stands for the post macOS rejected.
        let retry = gate.allows(
            intent(.blocked, "s1"), at: 1, settings: settings, windowFocused: false,
            authorized: true)
        #expect(retry, "a rejected banner must not silence the retry")

        gate.posted(intent(.blocked, "s1"), at: 1)
        let afterDelivery = gate.allows(
            intent(.blocked, "s1"), at: 2, settings: settings, windowFocused: false,
            authorized: true)
        #expect(!afterDelivery, "a delivered banner does start the window")
    }

    /// A refusal is not a delivery either: an intent the gate itself turned away never reached
    /// a post, so it must leave the clock alone.
    @Test func aSuppressedIntentDoesNotStartTheCooldownClock() {
        var gate = NotificationGate()
        let suppressed = gate.allows(
            intent(.done, "s1"), at: 0, settings: settings, windowFocused: true, authorized: true)
        #expect(!suppressed)
        let next = gate.allows(
            intent(.done, "s1"), at: 1, settings: settings, windowFocused: false, authorized: true)
        #expect(next)
    }

    /// `init(cooldown: 0)` disables the de-duplication outright, which is the seam a test that
    /// needs two consecutive posts uses. Kept honest here so the parameter is not dead code —
    /// including the `posted` half, which must record nothing at all.
    @Test func aZeroCooldownNeverDrops() {
        var gate = NotificationGate(cooldown: 0)
        let first = gate.allows(
            intent(.done, "s1"), at: 0, settings: settings, windowFocused: false, authorized: true)
        #expect(first)
        gate.posted(intent(.done, "s1"), at: 0)
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

    /// A private suite per call, emptied on creation so a crashed earlier run cannot seed it —
    /// the same shape every other test file in this target uses.
    private func scratch() -> UserDefaults {
        let name = "run.shepherd.mac.notifymodel.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
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
    /// first one's delivery stamps the gate before the second frame is ever asked. The tap is a
    /// strictly serial `for await`, so there is no window in which both can be asked first.
    @Test func aSecondFrameInsideTheCooldownPostsNothing() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        for _ in 0..<2 {
            await m.handle(.sessionStatus(.init(id: "s1", status: SessionStatus(known: .done))))
        }
        #expect(center.posted.count == 1)
    }

    /// A muted `agent` category silences every kind that rides it, `ready` included — asserted
    /// through the model so the gate's composition (`enabled && isOn(category)`) is covered
    /// where it is used.
    ///
    /// `ready` is the case worth pinning: the web exempts it from the category filter, and this
    /// port deliberately does not. The web's `ready` push only fires in reduced-push mode (its
    /// `ReadyNotifier.tick` returns unless `config.reducedPushMode`), where the toggles are
    /// bypassed wholesale anyway; here `ready` comes from the operator's own manual
    /// ready-to-merge toggle, so the exemption would mean an un-muteable banner announcing
    /// something they had just done themselves.
    @Test func aMutedAgentCategorySilencesReadyToo() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        m.save(NotificationSettings.default.setting(.agent, to: false))

        await m.handle(.sessionStatus(.init(id: "s1", status: SessionStatus(known: .done))))
        #expect(center.posted.isEmpty, "a muted category silences its own kinds")

        await m.handle(.sessionReady(.init(id: "s1", ready: true)))
        #expect(center.posted.isEmpty, "and `ready` is one of them — it rides the agent toggle")

        // The mute is per category, not a second master switch: a `ci` kind still gets out.
        await m.handle(
            .automergeStatus(
                AutoMergeStatus(
                    repoPath: "/repos/a", enabled: true, state: "merge_error", detail: "TASK-07",
                    sessionId: "s1")))
        #expect(center.posted.count == 1, "the other category is untouched")
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
        // No yield: the clear goes through the seam's synchronous `clearBadgeNow()`, so it has
        // already landed by the time `teardown()` returns. See the next test for why that
        // matters and not merely for why it is tidier.
        #expect(center.badge == 0, "a profile switch must not leave the old server's count up")
    }

    /// The profile switch, in the order `AppModel.activate(_:)` really runs it: `teardown()` on
    /// the outgoing extension, then `makeExtensions(store:)` builds the incoming one, then the
    /// incoming one writes its first badge. The Dock badge is process-global, so those two
    /// models are writing the same number.
    ///
    /// With the clear on an unstructured `Task` nothing ordered it against that first write —
    /// unstructured tasks on an actor carry no such promise — and the outgoing profile's zero
    /// could land on top of the incoming profile's count. That is not a frame of flicker: the
    /// incoming model's `lastBadge` is already N, so `writeBadge(_:)` elides every rewrite of N
    /// and the Dock stays wrong until the derived count happens to move.
    @Test func theTeardownClearCannotLandOnTheNextProfilesCount() async {
        let center = FakeNotificationCenter()
        let blocked = PreviewData.session(id: "a", status: SessionStatus(known: .blocked))
        var ready = PreviewData.session(id: "b", status: SessionStatus(known: .idle))
        ready.readyToMerge = true

        let outgoing = await model(center: center)
        await outgoing.setWindowFocused(false)
        await outgoing.updateBadge(sessions: [blocked])
        #expect(center.badge == 1)

        outgoing.teardown()
        #expect(center.badge == 0, "the clear landed before teardown() returned")
        #expect(center.synchronousClears == 1, "and it did not go through a Task hop")

        // No suspension between the two, exactly as in `activate(_:)`.
        let incoming = await model(center: center)
        await incoming.setWindowFocused(false)
        await incoming.updateBadge(sessions: [blocked, ready])
        #expect(center.badge == 2)

        // Whatever the outgoing model left for the scheduler runs here. Nothing it left may
        // reach the Dock.
        await Task.yield()
        await Task.yield()
        #expect(center.badge == 2, "the outgoing profile cannot clear the incoming one's count")

        // `badge` alone cannot see the elision — a rewrite of 2 leaves 2 either way — so the
        // write count is what is asserted: the incoming model's `lastBadge` still records what
        // is really on the Dock, which is the half of the bug that made the old failure stick.
        let writes = center.badgeWrites
        await incoming.updateBadge(sessions: [blocked, ready])
        #expect(center.badge == 2)
        #expect(center.badgeWrites == writes, "the elision is still measuring against the truth")
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
        #expect(center.badge == 0, "and so does a teardown, synchronously")
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

    /// The cooldown's half of the same `sent` flag, end to end and on a **frozen** clock, so
    /// nothing but the stamp can decide the outcome.
    ///
    /// `notificationd` rejects `add(_:)` transiently. With the stamp on the allowed branch, that
    /// rejection started the 120 s window anyway: the `session:block` the server re-sends 30 s
    /// later was refused, the agent sat blocked, and the operator was never told — where the web
    /// (`if (sent && cooldownMs > 0) this.lastNotified.set(key, t)`) delivers on the retry.
    @Test func aRejectedBannerDoesNotStartTheCooldownButADeliveredOneDoes() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)  // the default `{ 0 }` clock: time never moves
        await m.setWindowFocused(false)
        let block = BlockReason(shape: .init(value1: .stall), options: [], tail: [])
        let frame = ServerEvent.sessionBlock(.init(id: "s1", block: block))

        center.nextPostSucceeds = false
        await m.handle(frame)
        #expect(center.posted.count == 1, "the attempt was made")

        center.nextPostSucceeds = true
        await m.handle(frame)
        #expect(
            center.posted.count == 2,
            "a banner macOS threw away must not silence the next 120 s of this session")

        await m.handle(frame)
        #expect(center.posted.count == 2, "and a delivered one does start that window")
    }

    /// Authorization is not a launch-time constant. An operator who reads the denied note,
    /// grants permission in System Settings and comes back had every banner suppressed for the
    /// rest of the process: macOS prompts only once, so the panel's button cannot recover it
    /// either. Becoming active re-reads the status.
    @Test func comingBackToTheAppRereadsTheAuthorization() async {
        let center = FakeNotificationCenter()
        center.nextAuthorization = .denied
        let m = await model(center: center)
        #expect(m.authorization == .denied)

        // System Settings, then back to Shepherd.
        center.nextAuthorization = .granted
        await m.setWindowFocused(true)
        #expect(m.authorization == .granted, "the cached denial must not outlive the grant")

        await m.setWindowFocused(false)
        await m.handle(.sessionReady(.init(id: "s1", ready: true)))
        #expect(center.posted.count == 1, "and banners flow again without a relaunch")
    }

    /// Waits until `center` has seen `reads` authorization reads, so a test can be sure a
    /// parked read has really reached the centre before it starts the next one. Bounded, so a
    /// read that never arrives fails the assertion that follows instead of hanging the suite.
    private func awaitReads(_ reads: Int, on center: FakeNotificationCenter) async {
        for _ in 0..<1_000 {
            if center.authorizationReads >= reads { return }
            await Task.yield()
        }
    }

    /// Two authorization reads overlap in ordinary use — opening the settings panel starts one,
    /// coming back to the app starts another — and nothing promises they resume in the order
    /// they were issued. The read that captured the pre-grant `.denied` must not land on top of
    /// the one that captured `.granted` afterwards, or every banner stays suppressed until
    /// something happens to refresh again.
    @Test func anAuthorizationReadANewerOneOvertookIsDropped() async {
        let center = FakeNotificationCenter()
        center.nextAuthorization = .denied
        let m = await model(center: center)
        #expect(m.authorization == .denied)

        center.suspendsAuthorizationReads = true
        // The panel opens while permission is still denied.
        let stale = Task { await m.refreshAuthorization() }
        await awaitReads(1, on: center)
        // The operator grants it in System Settings and comes back, which reads again.
        let fresh = Task { await m.refreshAuthorization() }
        await awaitReads(2, on: center)

        center.completeAuthorizationRead(1, with: .granted)
        await fresh.value
        #expect(m.authorization == .granted)

        center.completeAuthorizationRead(0, with: .denied)
        await stale.value
        #expect(
            m.authorization == .granted,
            "an overtaken read must not restore the status macOS has already moved past")
    }

    /// The same guard from the other side: the panel's "Allow notifications" button is an ask,
    /// not a read, and its answer is the newest thing anyone knows. A plain read that was
    /// already in flight when the operator pressed it must not put the denial back.
    @Test func anInFlightReadDoesNotOverwriteAnExplicitGrant() async {
        let center = FakeNotificationCenter()
        center.nextAuthorization = .denied
        let m = await model(center: center)

        center.suspendsAuthorizationReads = true
        let stale = Task { await m.refreshAuthorization() }
        await awaitReads(1, on: center)

        // The button. `requestAuthorization` is not parked — only reads are.
        center.nextAuthorization = .granted
        await m.requestAuthorization()
        #expect(m.authorization == .granted)

        center.completeAuthorizationRead(0, with: .denied)
        await stale.value
        #expect(
            m.authorization == .granted,
            "a read issued before the grant must not overwrite it")
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

    @Test func archivedOwedRecordsRemainActionableAttention() async {
        SessionSignals.manualStepsOutstanding = { ["archived": 1] }
        defer { SessionSignals.manualStepsOutstanding = { [:] } }
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        await m.setWindowFocused(false)
        m.extraAttention = ["archived", "phantom"]
        await m.updateBadge(sessions: [])
        #expect(center.badge == 1)
        SessionSignals.manualStepsOutstanding = { [:] }
        await m.updateBadge(sessions: [])
        #expect(center.badge == 0)
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

    /// The two badge branches of `setWindowFocused`, each pinned on its own rather than through
    /// a race between them.
    ///
    /// This replaces a test that ran the two transitions as concurrent `async let` children and
    /// asserted on whichever landed last. That was both toothless and wrong: the seam has no
    /// store, so `await store?.setActive(focused)` never suspends and whole-call order decided
    /// the outcome — and for one of the two orders (focus-in first) the assertion was false,
    /// because the forced clear leaves `lastBadge` at 0 and the focus-out refresh then derives 0
    /// and elides, so the badge reads 0 while the model reads unfocused.
    ///
    /// What the branches must do is not order-dependent at all: coming forward forces the clear
    /// through whatever `lastBadge` says, and an unfocused refresh that derives an unchanged
    /// count writes nothing.
    @Test func focusingForcesTheClearAndAnUnfocusedRefreshElidesAnUnchangedCount() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)

        await m.setWindowFocused(false)
        await m.updateBadge(sessions: [])
        #expect(center.badge == 0, "zero is now the last count this model wrote")

        // A count on the Dock this model did not write, put there behind its back — what tells
        // a forced write from an elided one.
        await center.setBadgeCount(7)

        await m.setWindowFocused(false)
        #expect(!m.windowFocused)
        #expect(center.badge == 7, "an unfocused refresh deriving the same zero writes nothing")

        await m.setWindowFocused(true)
        #expect(m.windowFocused)
        #expect(center.badge == 0, "coming forward clears whatever `lastBadge` already says")
    }

    /// A badge write macOS rejects must not be cached as if it had landed.
    ///
    /// `writeBadge(_:)` skips an unchanged count to spare the serial event tap an XPC round trip
    /// per frame. That cache is only sound while it records what really reached the Dock: a
    /// rejected write cached as landed would leave the Dock showing the previous number until
    /// the derived count happened to move — minutes, on a quiet server, and never at all if the
    /// count is stable.
    @Test func aRejectedBadgeWriteIsRetriedOnTheNextRefresh() async {
        let center = FakeNotificationCenter()
        let m = await model(center: center)
        let blocked = PreviewData.session(id: "a", status: SessionStatus(known: .blocked))

        await m.setWindowFocused(false)
        center.reset()

        center.nextBadgeWriteSucceeds = false
        await m.updateBadge(sessions: [blocked])
        #expect(center.badgeWrites == 1, "the write was attempted")
        #expect(center.badge == 0, "a rejected write never reaches the Dock")

        center.nextBadgeWriteSucceeds = true
        await m.updateBadge(sessions: [blocked])
        #expect(center.badgeWrites == 2, "the same count goes out again after a rejection")
        #expect(center.badge == 1)

        await m.updateBadge(sessions: [blocked])
        #expect(center.badgeWrites == 2, "and once it lands, the elision is back")
    }
}

@Suite(.serialized) @MainActor
struct NotificationWindowStateTests {
    init() { resetStreamSeams() }
    @Test func notificationPaneAndModelRegisterOnce() {
        let suite = "notification-scene-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer {
            defaults.removePersistentDomain(forName: suite)
            resetStreamSeams()
        }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        defer { app.teardown() }
        NotificationsStream.install(app); NotificationsStream.install(app)
        SettingsFeature.installScene(); SettingsFeature.installScene()
        #expect(app.extensionFactories.count == 1)
        #expect(SettingsPaneEntry.notifications(in: app) == nil)
        #expect(SettingsPaneRegistry.panes.filter { $0.id == "notifications" }.count == 1)
    }
    @Test func permissionCopySurvivesPanelRetirement() {
        #expect(NotificationSettingsView.permissionNote(for: .denied)
            == L.t("native_notify_settings_permission_denied"))
        #expect(NotificationSettingsView.permissionNote(for: .granted) == nil)
        #expect(NotificationSettingsView.permissionNote(for: .notDetermined) == nil)
        #expect(NotificationSettingsView.showsAskButton(for: .notDetermined))
        #expect(!NotificationSettingsView.showsAskButton(for: .granted))
        #expect(!NotificationSettingsView.showsAskButton(for: .denied))
    }
    @Test func paneResolvesNewActivationAndCannotWriteThroughRetiredModel() async throws {
        let suite = "notification-scene-switch-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        defer { app.teardown() }
        NotificationsStream.install(app)
        let first = try app.addRemoteProfile(name: "first", address: "https://first.example.ts.net")
        await app.activate(first)
        let old = try #require(SettingsPaneEntry.notifications(in: app))
        let generation = app.activationGeneration
        let second = try app.addRemoteProfile(name: "second", address: "https://second.example.ts.net")
        await app.activate(second)
        let current = try #require(SettingsPaneEntry.notifications(in: app))
        #expect(current !== old)
        #expect(app.activationGeneration != generation)
        let oldSettings = old.settings
        let currentSettings = current.settings
        old.save(oldSettings.settingEnabled(!oldSettings.enabled))
        #expect(old.settings == oldSettings)
        #expect(current.settings == currentSettings)
        app.teardown() // Synchronous generation change, before any observer can arm.
        #expect(SettingsPaneEntry.notifications(in: app) == nil)
        #expect(!old.isSubscribed); #expect(!current.isSubscribed)
    }
}
