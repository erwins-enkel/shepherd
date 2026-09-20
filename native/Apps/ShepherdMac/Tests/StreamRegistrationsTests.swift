import Foundation
import ShepherdKit
import Testing

@testable import Shepherd

@MainActor
struct StreamRegistrationsTests {
    /// Scene registration runs from `ShepherdApp.init()`, before any scene reads the
    /// non-observable registries. The model-bound installation happens later.
    @Test func installSceneNeedsNoModelAndIsIdempotent() {
        CommandRegistry.reset()
        SettingsPaneRegistry.reset()
        StreamRegistrations.installScene()
        let firstCommands = MenuCommand.Menu.allCases.map { CommandRegistry.commands(in: $0).count }
        let firstPanes = SettingsPaneRegistry.panes.count
        StreamRegistrations.installScene()
        #expect(MenuCommand.Menu.allCases.map { CommandRegistry.commands(in: $0).count } == firstCommands)
        #expect(SettingsPaneRegistry.panes.count == firstPanes)
    }

    @Test func installAllIsStillIdempotentOverAModel() {
        // Never a bare `AppModel()` — its default credential store is the real Keychain.
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let model = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        StreamRegistrations.installAll(into: model)
        StreamRegistrations.installAll(into: model)
        // Registration is keyed by type and slots overwrite. Without a store no extension
        // is built, and a second pass must change nothing.
        #expect(model.store == nil)
    }
}
