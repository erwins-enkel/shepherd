import Foundation
import ShepherdKit
import Testing
@testable import Shepherd

@Suite(.serialized) @MainActor struct SettingsIntegrationTests {
    init() { resetStreamSeams() }

    @Test func installationAndResetCoverSettingsSeams() async throws {
        defer { resetStreamSeams() }
        let suite = "settings-seams-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        defer { app.teardown() }
        StreamRegistrations.installScene()
        #expect(SettingsPaneRegistry.panes.map(\.id) ==
            ["general", "notifications", "workspace", "clis", "access", "diagnose"])
        StreamRegistrations.installAll(into: app)
        StreamRegistrations.installAll(into: app)
        let types = app.extensionFactories.map(\.key)
        #expect(types.suffix(2) == [ObjectIdentifier(SettingsModel.self), ObjectIdentifier(SettingsReadyModel.self)])
        #expect(types.firstIndex(of: ObjectIdentifier(NotificationsModel.self))! < types.count - 2)
        #expect(types.firstIndex(of: ObjectIdentifier(HerdSignals.self))! < types.count - 2)
        let session = PreviewData.session(id: "a", status: .init(known: .idle))
        let git = try JSONDecoder().decode(GitState.self, from:
            Data(#"{"state":"open","checks":"failure","deployConfigured":false}"#.utf8))
        SettingsNotificationBridge.git = { _ in ["a": git] }
        SettingsNotificationBridge.reviewing = { _, _ in true }
        SettingsNotificationBridge.sendReady = { _, _ in true }
        SettingsPresentation.shared.palette = true
        SettingsPresentation.shared.openSettingsRequest = 7
        resetStreamSeams()
        #expect(SettingsNotificationBridge.git(app).isEmpty)
        #expect(!SettingsNotificationBridge.reviewing(app, "a"))
        #expect(!(await SettingsNotificationBridge.sendReady(app, session)))
        #expect(!SettingsPresentation.shared.palette)
        #expect(SettingsPresentation.shared.openSettingsRequest == 0)
        #expect(SettingsPaneRegistry.panes.isEmpty)
        StreamRegistrations.installScene()
        #expect(SettingsPaneRegistry.panes.count == 6)
    }

    @Test func notificationBridgesResolveEachActivationAndDefaultToReducedPolicy() async throws {
        defer { resetStreamSeams() }
        let suite = "settings-activation-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
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

    @Test(arguments: [false, true])
    func settingsFactoriesAreSinglePerActivationAcrossRegistrationOrders(registerFirst: Bool) async throws {
        defer { resetStreamSeams() }
        let suite = "settings-factory-orders-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        defer { app.teardown() }
        app.health = { _ in throw CancellationError() }
        // No credential means SessionStore never opens a socket. Health is stubbed above.
        let local = app.addLocalProfile(port: 1)
        if registerFirst { SettingsFeature.install(app) }
        await app.activate(local)
        SettingsFeature.install(app)
        let firstSettings = try #require(app.extension(SettingsModel.self))
        let firstRecovery = try #require(app.extension(BackendRecoveryModel.self))
        SettingsFeature.install(app)
        #expect(app.extension(SettingsModel.self) === firstSettings)
        #expect(app.extension(BackendRecoveryModel.self) === firstRecovery)
        #expect(app.extensionFactories.count == 3)
        #expect(app.liveExtensions.count == 3)

        let remote = try app.addRemoteProfile(name: "Fixture", address: "https://settings.example.invalid")
        await app.activate(remote)
        #expect(app.extension(SettingsModel.self) !== firstSettings)
        #expect(app.extension(BackendRecoveryModel.self) !== firstRecovery)
        #expect(app.liveExtensions.count == 3)
        SettingsFeature.install(app)
        #expect(app.liveExtensions.count == 3)
    }
}
