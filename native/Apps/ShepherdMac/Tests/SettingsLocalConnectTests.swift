import AppKit
import ShepherdKit
import Testing
@testable import Shepherd

@Suite(.serialized) @MainActor
struct SettingsLocalConnectTests {
    @Test func localConnectRoutesLoginBeforePresentingMain() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let suite = "settings-local-connect-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        defer { app.teardown() }
        let local = LocalServerModel(environment: LocalServerEnvironment(home: home), probeExternal: { true })
        await local.refresh()
        local.acknowledgeExternalServer()
        #expect(local.externalAcknowledged)
        var presented = false
        SettingsConnectionRouting.connectLocal(local, app: app) {
            guard case .login(let profile) = app.sheet else {
                Issue.record("Main scene presented before local login was routed")
                return
            }
            #expect(profile.baseURL == local.baseURL)
            presented = true
        }
        #expect(presented)
        #expect(app.store == nil, "Presenting login must not bypass authentication")
    }

    @Test func absentMainWindowOpensMainScene() {
        var opened = false
        SettingsConnectionRouting.showMainWindow(windows: []) { opened = true }
        #expect(opened)
    }

    @Test func existingMainWindowIsPresentedWithoutOpeningDuplicate() {
        let main = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 520, height: 360),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        main.title = "Shepherd"
        defer { main.orderOut(nil) }
        #expect(!main.isVisible)
        var opened = false
        SettingsConnectionRouting.showMainWindow(windows: [main]) { opened = true }
        #expect(main.isVisible)
        #expect(!opened)
    }
}
