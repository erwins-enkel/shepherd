import Foundation
import ShepherdKit
import Testing
import os

@testable import Shepherd
@testable import ShepherdAppCore

@MainActor
struct NotificationGateTests {
    private let settings = NotificationSettings.default

    private func intent(_ kind: NotificationKind, _ id: String) -> NotificationIntent {
        NotificationIntent(kind: kind, sessionID: id, subject: id)
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

    /// Waits until `center` has seen `reads` authorization reads, so a test can be sure a
    /// parked read has really reached the centre before it starts the next one. Bounded, so a
    /// read that never arrives fails the assertion that follows instead of hanging the suite.
    private func awaitReads(_ reads: Int, on center: FakeNotificationCenter) async {
        for _ in 0..<1_000 {
            if center.authorizationReads >= reads { return }
            await Task.yield()
        }
    }

}

extension MacSeamTests {
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
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
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
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
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
}
