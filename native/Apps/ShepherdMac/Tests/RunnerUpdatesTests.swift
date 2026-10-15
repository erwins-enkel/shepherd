import Foundation
import SwiftUI
import Testing
import ShepherdKit
@testable import ShepherdAppCore
@testable import Shepherd

extension MacSeamTests {
@Suite(.serialized) @MainActor struct RunnerUpdatesTests {
    @Test func settingsOwnsUpdatesAcrossProfileSwitchAndTeardown() async throws {
        resetStreamSeams(); defer { resetStreamSeams() }
        let suite = "runner-updates-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(),
            notifications: MacTestSupport.environment(defaults: defaults))
        defer { app.teardown() }
        app.health = { _ in throw CancellationError() }
        app.credentialProbe = { _, _ in StoredCredential(token: "fixture", tokenId: "fixture") }
        SettingsFeature.install(app)
        await app.activate(app.addLocalProfile(port: 1))
        let first = try #require(app.extension(SettingsModel.self))
        let store = try #require(app.store)
        first.installRunnerUpdates(store: store, app: app)
        let updates = try #require(first.runnerUpdates)
        first.installRunnerUpdates(store: store, app: app)
        #expect(first.runnerUpdates === updates)
        let next = try app.addRemoteProfile(name: "Next", address: "https://runner.example.invalid")
        await app.activate(next)
        #expect(first.runnerUpdates == nil && updates.herdr == nil && updates.codex == nil)
        #expect(!updates.canRun(.updateCodex))
        let second = try #require(app.extension(SettingsModel.self))
        #expect(second !== first && second.runnerUpdates == nil)
        second.installRunnerUpdates(store: try #require(app.store), app: app)
        #expect(second.runnerUpdates !== updates)
    }

    @Test func screenshotIndicatorsAndDetailsUseLocalizedCopy() async throws {
        let herdr = try JSONDecoder().decode(HerdrUpdateStatus.self, from: Data(#"{"current":"0.8.2","latest":"0.9.3","updateAvailable":true,"notes":null,"checkedAt":1}"#.utf8))
        let codex = try JSONDecoder().decode(CodexUpdateStatus.self, from: Data(#"{"current":"0.160.1","latest":"0.162.1","updateAvailable":true,"notes":null,"checkedAt":1}"#.utf8))
        let model = RunnerUpdatesModel(reads: .init(herdr: { herdr }, codex: { codex },
            notes: { .init(current: codex.current, latest: codex.latest, notes: [], complete: false) }, apply: { _ in }))
        await model.loadHerdr(); await model.loadCodex()
        #expect(model.showsHerdr && model.showsCodex)
        let indicator = RunnerUpdatesIndicator(model: model, serverName: "fixture", sessions: [])
        let details = RunnerUpdatesView(model: model, serverName: "fixture", sessions: [])
        _ = indicator.body; _ = details.body
        #expect(L.t("native_runner_indicator", "herdr", "0.8.2", "0.9.3").contains("0.9.3"))
        #expect(L.t("native_runner_server", "fixture").contains("fixture"))
        #expect(L.t("native_runner_confirm") != "native_runner_confirm")
        model.teardown()
    }
}
}
