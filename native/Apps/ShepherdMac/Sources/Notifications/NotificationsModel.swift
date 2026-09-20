// AppKit for exactly one read — `NSApp?.isActive` in `init` — because there is no other way to
// ask whether the app is frontmost *right now*, and starting from the wrong answer is the bug
// described at that call site. The activation *notifications* are still spelled as raw names
// below: what cost this app its window before was an `.onReceive` on the `App`'s body, not the
// import itself.
import AppKit
import Foundation
import Observation
import ShepherdKit

/// Local notifications for the active profile.
///
/// An `AppExtension`, so it is built in `AppModel.activate(_:)` once the store exists and torn
/// down right before that store stops — which is also what scopes the settings, the cooldown
/// table and the badge to one server.
///
/// It owns three things the rest of the app does not: the focus signal (which it also forwards
/// to the server as a presence frame, so browser push stays quiet while the Mac app is in front),
/// the badge, and the click that selects a session.
@Observable
@MainActor
final class NotificationsModel: AppExtension {
    private(set) var settings: NotificationSettings
    private(set) var authorization: NotificationAuthorization = .notDetermined
    private(set) var windowFocused = false
    private(set) var isSubscribed = false

    /// Session ids that need the operator for a reason this build cannot see — S2's ci-red, and
    /// a plan gate with unanswered questions. Empty until the integration lane assigns it; the
    /// badge counts blocked ∪ ready-to-merge ∪ (this ∩ the live sessions).
    ///
    /// Assigning it refreshes the badge itself rather than waiting for the next frame: on a quiet
    /// server the next frame can be minutes away, and a Dock icon that lags the reason it is
    /// lit is a seam the integration lane cannot use. Unchanged values are ignored (a re-assign
    /// per frame would undo the badge elision below) and a torn-down model does nothing at all.
    var extraAttention: Set<String> = [] {
        didSet {
            guard extraAttention != oldValue, !isTornDown else { return }
            Task { [weak self] in await self?.refreshBadge() }
        }
    }

    private let center: any NotificationCenterClient
    private let settingsStore: NotificationSettingsStore
    private let profileID: UUID
    /// Milliseconds since the Unix epoch. The *same* closure is handed to `NotificationTrigger`,
    /// so the usage latch and the cooldown can never disagree about what time it is.
    private let now: @Sendable () -> Int
    private var trigger: NotificationTrigger
    private var gate = NotificationGate()

    @ObservationIgnored private var tap: Task<Void, Never>?
    @ObservationIgnored private var launchTask: Task<Void, Never>?
    @ObservationIgnored private var focusObservers: [any NSObjectProtocol] = []
    /// The hop an activation notification schedules. Tracked so `teardown()` can cancel it: an
    /// untracked one can resume after a profile switch and write the outgoing centre's badge
    /// over the count the incoming profile just set — the Dock badge is global.
    @ObservationIgnored private var focusTask: Task<Void, Never>?
    /// The last count actually written to the centre, or `nil` when the next write must go
    /// through whatever it is. See `writeBadge(_:)`.
    @ObservationIgnored private var lastBadge: Int?
    /// Set by `teardown()`. Every path that can resume after it checks this before touching the
    /// centre, because the centre outlives the teardown on purpose (it still has a badge to
    /// clear) and the delegate macOS holds is weak.
    @ObservationIgnored private var isTornDown = false
    @ObservationIgnored private weak var store: SessionStore?
    @ObservationIgnored private var badgeSource: @MainActor () -> [Session] = { [] }

    /// `NSApplication`'s activation notifications, spelled out as strings rather than reached
    /// through the AppKit constants — the same trick `IsolatedLaunch` uses, and for the same
    /// reason: observing them through the SwiftUI layer has cost this app its window before.
    private static let didBecomeActive = Notification.Name(
        "NSApplicationDidBecomeActiveNotification")
    private static let willResignActive = Notification.Name(
        "NSApplicationWillResignActiveNotification")

    // MARK: - Init

    init(store: SessionStore, app: AppModel) {
        let isolated = LaunchEnvironment.configuration().isIsolated
        // An isolated launch (every XCUITest and the unit bundle's host app) gets the fake, so it
        // never asks macOS for permission and never posts a real banner. That is what keeps an
        // unattended run from stalling behind a system dialog. This is the app's ONLY
        // construction site for `SystemNotificationCenter`.
        self.center = isolated ? FakeNotificationCenter() : SystemNotificationCenter()
        let settingsStore = NotificationSettingsStore(
            defaults: isolated
                ? (UserDefaults(
                    suiteName: "run.shepherd.mac.notifications.isolated.\(UUID().uuidString)")
                    ?? .standard)
                : .standard)
        // A throwaway id means the settings written under it are read back by nobody: the
        // operator mutes a category, relaunches, and it is on again. That cannot happen from
        // `AppModel.activate` (the profile is set before the extensions are built), so if it
        // ever does, the log is the only way anyone will find out. The identifier only — a
        // profile's name is the operator's own.
        let activeProfileID = app.activeProfile?.id
        if activeProfileID == nil {
            Log.app.error(
                "notifications: no active profile at build time; settings will not persist")
        }
        let profileID = activeProfileID ?? UUID()
        let clock: @Sendable () -> Int = { Int(Date().timeIntervalSince1970 * 1_000) }
        self.settingsStore = settingsStore
        self.profileID = profileID
        self.now = clock
        self.settings = settingsStore.load(for: profileID)
        // One clock for the trigger's usage latch and this model's cooldown, in milliseconds.
        self.trigger = NotificationTrigger(
            subjectFor: { [weak store] id in store?.session(id: id)?.name },
            now: clock)
        self.store = store
        self.badgeSource = { [weak store] in store?.sessions ?? [] }

        center.onSelectSession = { [weak app] id in
            // The seam, not an edit: `selectedSessionID` is `AppModel`'s own published property,
            // and `MainWindow` already reconciles a selection that no longer exists.
            app?.selectedSessionID = id
        }
        center.start()

        subscribe(to: store)
        observeFocus()
        // Sample the *current* activation state, synchronously, right here. `windowFocused`
        // starts false and `observeFocus()` only ever hears about the next transition, so
        // connecting — or switching profiles — while the app is already frontmost would leave
        // every notification un-suppressed and the badge counting until the operator happened
        // to click away and back.
        //
        // Synchronously, because a sample *applied* after the authorization await below would
        // be a stale one: an operator who switches away while macOS is still answering would
        // have the observer's `false` overwritten by this `true`, and notifications would stay
        // suppressed — and presence active — until the next focus transition.
        windowFocused = NSApp?.isActive ?? false
        // Two suspension points, so the activation generation is captured before the first one
        // and re-checked after it: a profile switch while macOS is still answering must not let
        // the outgoing activation's answer land on the incoming one. `teardown()` cancels this
        // task as well, so neither await can outlive the extension.
        let generation = app.activationGeneration
        launchTask = Task { [weak self, weak app] in
            await self?.refreshAuthorization()
            guard let self, let app, app.activationGeneration == generation else { return }
            // The live value, never a captured one: forwarding presence and setting the first
            // badge is still this task's job, but it forwards whatever is true now.
            await self.setWindowFocused(self.windowFocused)
        }
    }

    /// Test/preview seam: no store, no socket, no AppKit notifications.
    init(
        center: any NotificationCenterClient,
        settingsStore: NotificationSettingsStore,
        profileID: UUID,
        now: @escaping @Sendable () -> Int,
        subjectFor: @escaping @MainActor (String) -> String?,
        select: @escaping @MainActor (String) -> Void
    ) {
        self.center = center
        self.settingsStore = settingsStore
        self.profileID = profileID
        self.now = now
        self.settings = settingsStore.load(for: profileID)
        self.trigger = NotificationTrigger(subjectFor: subjectFor, now: now)
        center.onSelectSession = select
        center.start()
    }

    // MARK: - Events

    private func subscribe(to store: SessionStore) {
        isSubscribed = true
        // The stream lives only inside the task, so cancelling the task is what releases the
        // tap — a stream parked in a property would go on buffering frames nobody reads.
        let events = store.events()
        tap = Task { [weak self] in
            for await event in events {
                guard let self else { return }
                await self.handle(event)
            }
            self?.isSubscribed = false
        }
    }

    /// One frame in; zero or one banner out, plus a badge refresh.
    func handle(_ event: ServerEvent) async {
        // The whole frame, not just the branch that posts. The guard used to sit after the
        // post, which the loop only reaches when the gate allowed something — so a cancelled
        // tap carrying a frame with no intent (`session:activity`, `session:git`) or one the
        // gate refused still fell through to `refreshBadge()` below and wrote the outgoing
        // profile's count over the Dock badge, which is global.
        guard !Task.isCancelled else { return }
        for intent in trigger.intents(for: event) {
            guard
                gate.allows(
                    intent, at: now(), settings: settings, windowFocused: windowFocused,
                    authorized: authorization == .granted)
            else { continue }
            let sent = await center.post(
                NotificationRequest.make(
                    title: NotificationCopy.title(intent),
                    body: NotificationCopy.body(intent),
                    threadIdentifier: intent.threadIdentifier,
                    sessionID: intent.sessionID))
            // The port of `if (sent) store.setSetting(USAGE_WARNED_KEY, …)`, including the
            // `sent`: the 5-hour window is latched only on the branch where a banner really
            // reached the operator. Latching on a rejected delivery would suppress the rest of
            // the window with nothing delivered; not latching at all would let the server's
            // ~30 s `usage:limits` frames hand the operator a "5-hour limit" banner every two
            // minutes for the rest of it. A no-op for every other kind.
            //
            // The cooldown stamp deliberately stays where it is — synchronous, inside
            // `NotificationGate.allows`. See the comment there: this success flag is not a
            // reason to move it.
            if sent {
                trigger.usageWarningPosted(for: intent)
                // The kind, never the body: a body can name the operator's own work.
                Log.ui.info("posted a \(intent.kind.id, privacy: .public) notification")
            }
            // Honest about cancellation: today `intents(for:)` returns at most one intent, but
            // a second one must not be posted after the tap that is driving this was cancelled.
            guard !Task.isCancelled else { return }
        }
        await refreshBadge()
    }

    // MARK: - Focus

    private func observeFocus() {
        for (name, focused) in [(Self.didBecomeActive, true), (Self.willResignActive, false)] {
            let observer = NotificationCenter.default.addObserver(
                forName: name, object: nil, queue: nil
            ) { [weak self] _ in
                // `queue: nil` runs on the posting thread, and AppKit posts both on the main one.
                MainActor.assumeIsolated {
                    guard let self else { return }
                    // Tracked, so `teardown()` can cancel a hop that has not started yet; the
                    // `isTornDown` guards in `setWindowFocused` close the same window for one
                    // that is already past its first suspension. The previous task is *not*
                    // cancelled: two rapid transitions must both land, in the order they
                    // arrived.
                    self.focusTask = Task { [weak self] in
                        guard !Task.isCancelled else { return }
                        await self?.setWindowFocused(focused)
                    }
                }
            }
            focusObservers.append(observer)
        }
    }

    /// Records the focus state, forwards it to the server as a presence frame — so the web push
    /// the operator's phone would get stays suppressed too, exactly as an open browser tab does —
    /// and clears the badge when the window comes forward.
    func setWindowFocused(_ focused: Bool) async {
        // A torn-down model has no server to tell and no badge of its own: the Dock badge is
        // global, so a late resign-active would clear the count the *incoming* profile set.
        guard !isTornDown else { return }
        // Synchronously, before any suspension: this assignment is what keeps two rapid focus
        // transitions from landing out of order. An `await` in front of it would let the later
        // one write first and leave `windowFocused` reading the earlier value.
        windowFocused = focused
        await store?.setActive(focused)
        // Re-checked after the suspension, for the same reason as the guard above.
        guard !isTornDown else { return }
        // The *live* `windowFocused`, never the captured `focused`. Two focus tasks can
        // interleave at the suspension above — an actor makes no FIFO promise about which
        // resumes first — and branching on the capture lets the loser decide the badge: the
        // `false` task resumes first and refreshes to N, then the `true` task resumes and
        // clears to 0 while the window is in the background with N sessions needing the
        // operator. The de-duplication in `writeBadge(_:)` then makes that stick, because
        // `lastBadge` is 0 and nothing rewrites it until the derived count moves.
        //
        // The synchronous assignment above is what makes this read correct: whichever task
        // assigned last is the transition that really happened, so that is the one the badge
        // must follow, whatever order the resumptions land in.
        if windowFocused {
            await clearBadge()
        } else {
            await refreshBadge()
        }
    }

    // MARK: - Badge

    /// The web's `deriveTabState` count, minus the two inputs this build cannot see (see the
    /// plan's deviation 5). Only while the window is NOT focused, which is how the web tab
    /// behaves: attended means the count is in front of you already.
    ///
    /// Derived from the store's current sessions every time, never accumulated from the event
    /// tap: a tap is allowed to drop frames, and a count that only an unbroken sequence could
    /// produce would drift for the rest of the session.
    func updateBadge(sessions: [Session]) async {
        guard !isTornDown else { return }
        // `writeBadge`, not `clearBadge`: this is the ordinary per-frame path, and the
        // operator spends most of their day here — window in front, several agents running,
        // a `session:activity` / `session:claude-alive` / `session:git` frame every few
        // hundred milliseconds. `clearBadge()` drops `lastBadge` first, so routing this
        // branch through it meant the elision below could never fire and every one of those
        // frames cost an XPC round trip to `notificationd`, which is precisely what the
        // de-duplication exists to stop. The *transitions* that must not be elided —
        // focusing the window, and `teardown()` — call `clearBadge()` themselves.
        guard !windowFocused else {
            await writeBadge(0)
            return
        }
        var needing: Set<String> = []
        var live: Set<String> = []
        for session in sessions where session.status.known != .archived {
            live.insert(session.id)
            if session.status.known == .blocked { needing.insert(session.id) }
            if session.readyToMerge { needing.insert(session.id) }
        }
        // Intersected with the live, non-archived ids rather than unioned in wholesale: an id
        // the integration lane forgets to prune would otherwise be a phantom on the Dock that
        // the operator has no way to clear — no session to open, no state to change.
        needing.formUnion(extraAttention.intersection(live))
        await writeBadge(needing.count)
    }

    /// Re-derives the badge from whatever the store holds now.
    private func refreshBadge() async {
        await updateBadge(sessions: badgeSource())
    }

    /// One XPC round trip to `notificationd` per *change of the count this model wrote*, not
    /// per frame. Every caller but the two named below goes through here and is elidable,
    /// focused or not.
    ///
    /// `handle(_:)` refreshes the badge for every frame the tap delivers, including the
    /// high-rate ones this model ignores (`session:activity`, `session:claude-alive`,
    /// `session:git`). The tap is strictly serial and `SessionStore+EventTap` buffers only
    /// `.bufferingNewest(64)`, so parking the consumer on a round trip per frame is how a burst
    /// of activity overflows that buffer — and the frame it drops can be the one `session:block`
    /// the banner depended on, invisibly, because the badge is re-derived and stays correct.
    ///
    /// `lastBadge` records what really reached the Dock, so it is committed *after* the write,
    /// and only when `setBadgeCount` says the write landed. A rejection leaves it `nil`, which
    /// forces the next refresh to write the same count again rather than eliding it against a
    /// number that was never there — the failure mode the whole cache would otherwise turn into
    /// a permanently stale Dock icon.
    ///
    /// `isTornDown` is re-checked after the suspension for the same reason `setWindowFocused`
    /// re-checks it: `teardown()` can run while this write is in flight, and it drops
    /// `lastBadge` and forces its own clear. Committing this count afterwards would leave the
    /// outgoing profile's number recorded as the truth about a Dock badge that is global and
    /// has already been cleared.
    private func writeBadge(_ count: Int) async {
        guard lastBadge != count else { return }
        let landed = await center.setBadgeCount(count)
        guard landed, !isTornDown else {
            lastBadge = nil
            return
        }
        lastBadge = count
    }

    /// Clears the badge, never elided. `lastBadge` is dropped first, so a clear goes through
    /// even when the last count this model wrote was already zero — the Dock badge is global,
    /// and something else (the outgoing profile, a previous run) may have left a number on it.
    ///
    /// Exactly two callers force a write this way, and they are the two moments where
    /// `lastBadge` is not evidence about what is actually on the Dock: `setWindowFocused`
    /// when the window comes forward (the operator is now looking, and whatever is up there
    /// may have been written by the previous activation), and `teardown()`, which forces the
    /// same clear inline because it must outlive this model. Every other path — the per-frame
    /// refresh, focused or not — is an ordinary `writeBadge(_:)` and is elided when the count
    /// has not changed.
    private func clearBadge() async {
        lastBadge = nil
        await writeBadge(0)
    }

    // MARK: - Authorization and settings

    private func refreshAuthorization() async {
        authorization = await center.authorization()
    }

    /// Asks macOS once. A denial is recorded and shown in the settings panel with the path to
    /// System Settings — asking again would do nothing, because macOS only prompts once.
    ///
    /// A no-op once torn down: the settings panel re-hosts against the current activation's
    /// model on a profile switch, but a button tap already in flight when the switch happens
    /// would otherwise resolve against the outgoing profile's model after the fact.
    func requestAuthorization() async {
        guard !isTornDown else {
            Log.app.error("ignored a notification permission request after teardown")
            return
        }
        authorization = await center.requestAuthorization()
    }

    /// A no-op once torn down, logged rather than silent: a settings panel left open across a
    /// profile switch still holds this instance, and a toggle flipped on it must not persist to
    /// the profile that used to be active.
    func save(_ settings: NotificationSettings) {
        guard !isTornDown else {
            Log.app.error("ignored a notification-settings write after teardown")
            return
        }
        self.settings = settings
        settingsStore.save(settings, for: profileID)
    }

    // MARK: - Lifecycle

    func teardown() {
        isTornDown = true
        tap?.cancel()
        tap = nil
        launchTask?.cancel()
        launchTask = nil
        focusTask?.cancel()
        focusTask = nil
        isSubscribed = false
        for observer in focusObservers { NotificationCenter.default.removeObserver(observer) }
        focusObservers.removeAll()
        // `UNUserNotificationCenter.delegate` is weak and the centre is kept alive below to
        // clear the badge, so the outgoing profile's click handler is still installed with a
        // live closure. A banner for profile A clicked after the operator switched to profile B
        // would select A's session id against B's model — the list jumps to nothing selected.
        center.onSelectSession = nil
        store = nil
        badgeSource = { [] }
        // A profile switch must not leave the outgoing server's count on the Dock icon. Forced
        // through `lastBadge`, which `clearBadge()` would drop anyway: a clear is never elided.
        lastBadge = nil
        let center = self.center
        Task { await center.setBadgeCount(0) }
    }
}
