import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

/// `.serialized`: `DetailTabRegistry` is per-process state, same reason `DetailTabRegistryTests`
/// and `AppExtensionTests` are.
@MainActor
@Suite(.serialized)
struct DetailFeatureTests {
    init() { resetStreamSeams() }

    private func makeModel() -> AppModel {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
    }

    private func remote(_ model: AppModel, _ label: String) throws -> ServerProfile {
        try model.addRemoteProfile(name: label, address: "https://\(label).example.ts.net")
    }

    @Test func installRegistersTheActivityTabAtOrderTen() {
        let app = makeModel()
        DetailFeature.install(app)

        let tab = DetailTabRegistry.tabs.first { $0.id == "activity" }
        #expect(tab != nil)
        #expect(tab?.order == 10)
        #expect(DetailTabRegistry.tabs.map(\.id).contains("prompt"))
    }

    @Test func installBuildsTheModelImmediatelyWhenAStoreIsAlreadyLive() async throws {
        let app = makeModel()
        await app.activate(try remote(app, "one"))
        #expect(DetailFeature.model(app) == nil)

        DetailFeature.install(app)

        #expect(DetailFeature.model(app) != nil)
        app.teardown()
    }

    /// The brief's idempotency requirement: calling `install(_:)` a second (and third) time adds
    /// no second "activity" registration and builds no second `DetailModel` — the live instance
    /// an operator's tab is already reading from survives untouched.
    @Test func installIsIdempotent() async throws {
        let app = makeModel()
        DetailFeature.install(app)
        await app.activate(try remote(app, "two"))
        let first = try #require(DetailFeature.model(app))

        DetailFeature.install(app)
        DetailFeature.install(app)

        #expect(DetailTabRegistry.tabs.filter { $0.id == "activity" }.count == 1)
        #expect(DetailFeature.model(app) === first)
        app.teardown()
    }

    @Test func aFreshActivationGetsItsOwnModelOncePerStore() async throws {
        let app = makeModel()
        DetailFeature.install(app)

        await app.activate(try remote(app, "three"))
        let firstModel = try #require(DetailFeature.model(app))

        await app.activate(try remote(app, "four"))
        let secondModel = try #require(DetailFeature.model(app))

        #expect(firstModel !== secondModel)
        app.teardown()
    }

    @Test func theActivityTabHasNoModelToRenderBeforeInstall() async throws {
        let app = makeModel()
        await app.activate(try remote(app, "five"))
        #expect(DetailFeature.model(app) == nil)
        app.teardown()
    }
}
