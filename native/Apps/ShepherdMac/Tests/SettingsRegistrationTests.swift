import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
@Suite(.serialized) @MainActor struct SettingsRegistrationTests {
    @Test func sceneRegistrationIsModelFreeAndIdempotent() {
        resetStreamSeams()
        defer { resetStreamSeams() }
        SettingsFeature.installScene(); SettingsFeature.installScene()
        #expect(SettingsPaneRegistry.panes.map(\.id) == ["general","notifications","workspace","clis","access","diagnose"])
        #expect(CommandRegistry.commands(in:.view).filter {$0.shortcut == .init("k")}.count == 1)
        let suite = "SettingsRegistry-" + UUID().uuidString
        let defaults = UserDefaults(suiteName:suite)!
        defer {defaults.removePersistentDomain(forName:suite)}
        let app = AppModel(defaults:defaults,credentials:InMemoryCredentialStore())
        SettingsFeature.install(app); SettingsFeature.install(app)
        #expect(app.extensionFactories.count == 3)
        let rows = SettingsCommandSearch.rows(query:"",app:app)
        #expect(rows.contains {$0.id == "settings.open"})
        #expect(rows.first {$0.id == "settings.refresh"}?.isEnabled(app) == false)
        #expect(SettingsCommandSearch.rows(query:"zzzz_unmatchable",app:app).isEmpty)
        app.teardown()
    }
}
