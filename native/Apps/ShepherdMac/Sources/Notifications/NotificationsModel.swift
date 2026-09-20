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
    /// badge counts blocked ∪ ready-to-merge ∪ this.
    var extraAttention: Set<String> = []

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
        let profileID = app.activeProfile?.id ?? UUID()
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
        // Sample the *current* activation state before anything else. `windowFocused` starts
        // false and `observeFocus()` only ever hears about the next transition, so connecting —
        // or switching profiles — while the app is already frontmost would leave every
        // notification un-suppressed and the badge counting until the operator happened to click
        // away and back. `setWindowFocused` also forwards presence and sets the badge, so this
        // one call replaces the separate initial `updateBadge`.
        let active = NSApp?.isActive ?? false
        // Two suspension points, so the activation generation is captured before the first one
        // and re-checked after it: a profile switch while macOS is still answering must not let
        // the outgoing activation's answer land on the incoming one. `teardown()` cancels this
        // task as well, so neither await can outlive the extension.
        let generation = app.activationGeneration
        launchTask = Task { [weak self, weak app] in
            await self?.refreshAuthorization()
            guard let app, app.activationGeneration == generation else { return }
            await self?.setWindowFocused(active)
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
        for intent in trigger.intents(for: event) {
            guard
                gate.allows(
                    intent, at: now(), settings: settings, windowFocused: windowFocused,
                    authorized: authorization == .granted)
            else { continue }
            await center.post(
                NotificationRequest.make(
                    title: NotificationCopy.title(intent),
                    body: NotificationCopy.body(intent),
                    threadIdentifier: intent.threadIdentifier,
                    sessionID: intent.sessionID))
            // The port of `if (sent) store.setSetting(USAGE_WARNED_KEY, …)`: the 5-hour window is
            // latched here, on the branch where a banner really reached the operator, and
            // nowhere else. Without it the server's ~30 s `usage:limits` frames each clear the
            // cooldown eventually and the operator collects a "5-hour limit" banner every two
            // minutes for the rest of the window. A no-op for every other kind.
            trigger.usageWarningPosted(for: intent)
            // The kind, never the body: a body can name the operator's own work.
            Log.ui.info("posted a \(intent.kind.id, privacy: .public) notification")
        }
        await updateBadge(sessions: badgeSource())
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
                    Task { await self.setWindowFocused(focused) }
                }
            }
            focusObservers.append(observer)
        }
    }

    /// Records the focus state, forwards it to the server as a presence frame — so the web push
    /// the operator's phone would get stays suppressed too, exactly as an open browser tab does —
    /// and clears the badge when the window comes forward.
    func setWindowFocused(_ focused: Bool) async {
        windowFocused = focused
        await store?.setActive(focused)
        if focused {
            await center.setBadgeCount(0)
        } else {
            await updateBadge(sessions: badgeSource())
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
        guard !windowFocused else {
            await center.setBadgeCount(0)
            return
        }
        var needing: Set<String> = []
        for session in sessions where session.status.known != .archived {
            if session.status.known == .blocked { needing.insert(session.id) }
            if session.readyToMerge { needing.insert(session.id) }
        }
        needing.formUnion(extraAttention)
        await center.setBadgeCount(needing.count)
    }

    // MARK: - Authorization and settings

    private func refreshAuthorization() async {
        authorization = await center.authorization()
    }

    /// Asks macOS once. A denial is recorded and shown in the settings panel with the path to
    /// System Settings — asking again would do nothing, because macOS only prompts once.
    func requestAuthorization() async {
        authorization = await center.requestAuthorization()
    }

    func save(_ settings: NotificationSettings) {
        self.settings = settings
        settingsStore.save(settings, for: profileID)
    }

    // MARK: - Lifecycle

    func teardown() {
        tap?.cancel()
        tap = nil
        launchTask?.cancel()
        launchTask = nil
        isSubscribed = false
        for observer in focusObservers { NotificationCenter.default.removeObserver(observer) }
        focusObservers.removeAll()
        store = nil
        badgeSource = { [] }
        // A profile switch must not leave the outgoing server's count on the Dock icon.
        let center = self.center
        Task { await center.setBadgeCount(0) }
    }
}
