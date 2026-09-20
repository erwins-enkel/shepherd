import Foundation
import ShepherdKit
import Testing
@testable import Shepherd

@MainActor struct SettingsNotificationDeliveryTests {
    @Test func policyFiltersRawReadyAndDeliveryRetriesUntilSent() async {
        let suite = "settings-delivery-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let center = FakeNotificationCenter()
        let model = NotificationsModel(center: center,
            settingsStore: NotificationSettingsStore(defaults: defaults), profileID: UUID(),
            now: { 0 }, subjectFor: { _ in "fixture" }, select: { _ in })
        defer { model.teardown() }
        model.intentPolicy = { intent, evaluated in
            SettingsReadyRules.allows(kind: intent.kind.id, reduced: true, evaluatedReady: evaluated)
        }
        let ready = NotificationIntent(kind: .ready, sessionID: "a", subject: "fixture")
        #expect(!(await model.deliver(ready, evaluatedReady: true)))
        await model.requestAuthorization()
        await model.setWindowFocused(true)
        #expect(!(await model.deliver(ready, evaluatedReady: true)))
        await model.setWindowFocused(false)
        await model.handle(.sessionReady(.init(id: "a", ready: true)))
        await model.handle(.sessionStatus(.init(id: "a", status: .init(known: .done))))
        #expect(center.posted.isEmpty)
        center.nextPostSucceeds = false
        #expect(!(await model.deliver(ready, evaluatedReady: true)))
        center.nextPostSucceeds = true
        #expect(await model.deliver(ready, evaluatedReady: true))
        #expect(!(await model.deliver(ready, evaluatedReady: true)))
        #expect(center.posted.count == 2)
        model.teardown()
        #expect(!(await model.deliver(.init(kind: .ready, sessionID: "b", subject: "fixture"),
                                     evaluatedReady: true)))
        #expect(center.posted.count == 2)
    }
}
