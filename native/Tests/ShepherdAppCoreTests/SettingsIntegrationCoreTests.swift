import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

extension CoreSeamTests {
@Suite(.serialized) @MainActor struct SettingsIntegrationTests {
    init() { resetStreamSeams() }

    @Test func notificationBridgesResolveEachActivationAndDefaultToReducedPolicy() async throws {
        defer { resetStreamSeams() }
        let suite = "settings-activation-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        defer { app.teardown() }
        StreamRegistrations.installAll(into: app)
        let profile = ServerProfile(name: "fixture", baseURL: URL(string: "https://settings.invalid")!, mode: .remote)
        let session = PreviewData.session(id: "a", status: .init(known: .idle))
        var deliveries: [Int] = []
        for activation in 0..<2 {
            let store = try SessionStore(profile: profile, credentials: InMemoryCredentialStore())
            app.makeExtensions(store: store)
            let herd = try #require(app.extension(HerdSignals.self))
            let notifications = try #require(app.extension(NotificationsModel.self))
            herd.reads = .stub()
            herd.applyForTesting(name: "session:git", payload: [
                "id": "a", "git": ["state": "open", "checks": "failure", "deployConfigured": false],
            ])
            #expect(SettingsNotificationBridge.git(app)["a"]?.checks.known == .failure)
            #expect(!notifications.intentPolicy(.init(kind: .ready, sessionID: "a", subject: "fixture"), false))
            #expect(notifications.intentPolicy(.init(kind: .ready, sessionID: "a", subject: "fixture"), true))
            #expect(!notifications.intentPolicy(.init(kind: .done, sessionID: "a", subject: "fixture"), false))
            notifications.intentPolicy = { intent, evaluated in
                #expect(intent.sessionID == "a")
                #expect(evaluated)
                deliveries.append(activation)
                return false
            }
            #expect(!(await SettingsNotificationBridge.sendReady(app, session)))
            app.teardown()
            #expect(SettingsNotificationBridge.git(app).isEmpty)
            #expect(!SettingsNotificationBridge.reviewing(app, "a"))
            #expect(!(await SettingsNotificationBridge.sendReady(app, session)))
        }
        #expect(deliveries == [0, 1])
    }
}
}
