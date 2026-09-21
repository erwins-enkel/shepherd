import Foundation
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
@MainActor
struct MacNotificationEnvironmentTests {
    @Test func isolatedEnvironmentUsesFakeAndRemovesFocusObservation() async throws {
        let environment = MacNotificationEnvironment.make(configuration: .init(isIsolated: true, live: nil))
        let center = try #require(environment.makeCenter() as? FakeNotificationCenter)
        center.start()
        _ = await center.requestAuthorization()
        // The isolated factory exposes only the fake, so this cannot invoke system permission UI.
        #expect(environment.makeCenter() is FakeNotificationCenter)
        let focus = MacNotificationFocusSource()
        var events: [Bool] = []
        let cancel = focus.observe { events.append($0) }
        #expect(events.isEmpty)
        NotificationCenter.default.post(name: .init("NSApplicationDidBecomeActiveNotification"), object: nil)
        NotificationCenter.default.post(name: .init("NSApplicationWillResignActiveNotification"), object: nil)
        #expect(events == [true, false])
        #expect(focus.observerCountForTesting == 2)
        cancel()
        cancel()
        #expect(focus.observerCountForTesting == 0)
        NotificationCenter.default.post(name: .init("NSApplicationDidBecomeActiveNotification"), object: nil)
        #expect(events == [true, false])
        let defaults = environment.makeDefaults()
        let store = NotificationSettingsStore(defaults: defaults)
        let first = UUID(), second = UUID()
        defer {
            defaults.removeObject(forKey: NotificationSettingsStore.key(for: first))
            defaults.removeObject(forKey: NotificationSettingsStore.key(for: second))
        }
        let original = store.load(for: second)
        store.save(original.settingEnabled(false), for: first)
        #expect(!store.load(for: first).enabled)
        #expect(store.load(for: second) == original)
        #expect(environment.makeDefaults().data(forKey: NotificationSettingsStore.key(for: first)) == nil)
    }
}
}
