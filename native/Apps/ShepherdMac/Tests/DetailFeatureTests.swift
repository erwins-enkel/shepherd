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

    // MARK: - The identity a tab's load task keys on

    /// Session id alone is not enough: a profile switch builds a fresh `DetailModel` with empty
    /// caches, and a tab whose `.task(id:)` did not re-run for the same selected session would
    /// sit on a spinner nothing ever fills.
    @Test func theTaskKeyChangesWhenTheModelDoesEvenForTheSameSession() {
        let first = DetailModel(loaders: .stubbed())
        let second = DetailModel(loaders: .stubbed())

        #expect(DetailTaskKey(session: "s1", model: first) == DetailTaskKey(session: "s1", model: first))
        #expect(DetailTaskKey(session: "s1", model: first) != DetailTaskKey(session: "s1", model: second))
        #expect(DetailTaskKey(session: "s1", model: first) != DetailTaskKey(session: "s2", model: first))
    }

    // MARK: - The activity tab's state mapping

    @Test func theActivityPhaseMapsEveryLoadedState() {
        #expect(ActivityTabView.phase(for: .loading) == .loading)
        #expect(ActivityTabView.phase(for: .failed("nope")) == .failed("nope"))
        #expect(ActivityTabView.phase(for: .ready([])) == .empty(L.t("activity_empty")))
        let entry = ActivityEntry(ts: 1, tool: "Edit", summary: "did", status: .init(known: .ok))
        #expect(ActivityTabView.phase(for: .ready([entry])) == .content)
    }

    @Test func theActivityTabHasNoModelToRenderBeforeInstall() async throws {
        let app = makeModel()
        await app.activate(try remote(app, "five"))
        #expect(DetailFeature.model(app) == nil)
        app.teardown()
    }
}
