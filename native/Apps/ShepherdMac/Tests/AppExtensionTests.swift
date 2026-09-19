import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

/// What a fake extension recorded, kept off the fake so a test can read it after
/// the instance is gone.
@MainActor
final class ExtensionLedger {
    var created = 0
    var tornDown = 0
    /// At teardown time, was the model still holding the store this extension was
    /// built for? That proves `tearDownExtensions()` runs before the model lets go
    /// of the store — and so before `store.stop()`, which sits on the next line in
    /// both `activate(_:)` and `teardown()`.
    var storeStillOwnedAtTeardown: [Bool] = []
}

@MainActor
final class FakeExtension: AppExtension {
    /// The ledger the next instance writes to; `.serialized` keeps it to one.
    static var ledger = ExtensionLedger()

    let store: SessionStore
    private weak var app: AppModel?
    private let ledger: ExtensionLedger

    init(store: SessionStore, app: AppModel) {
        self.store = store
        self.app = app
        self.ledger = FakeExtension.ledger
        ledger.created += 1
    }

    func teardown() {
        ledger.tornDown += 1
        ledger.storeStillOwnedAtTeardown.append(app?.store === store)
    }
}

@MainActor
@Suite(.serialized)
struct AppExtensionTests {
    private func makeModel() -> AppModel {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        FakeExtension.ledger = ExtensionLedger()
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
    }

    private func remote(_ model: AppModel, _ label: String) throws -> ServerProfile {
        try model.addRemoteProfile(name: label, address: "https://\(label).example.ts.net")
    }

    @Test func itIsBuiltOnActivation_foundByType_andTornDownWhileTheStoreIsStillHeld()
        async throws
    {
        let model = makeModel()
        model.register(FakeExtension.self)
        #expect(model.extension(FakeExtension.self) == nil)

        await model.activate(try remote(model, "one"))
        let ext = try #require(model.extension(FakeExtension.self))
        #expect(ext.store === model.store)
        #expect(FakeExtension.ledger.created == 1)

        model.teardown()
        #expect(FakeExtension.ledger.tornDown == 1)
        #expect(FakeExtension.ledger.storeStillOwnedAtTeardown == [true])
        #expect(model.extension(FakeExtension.self) == nil)
    }

    @Test func switchingProfilesTearsTheOldOneDownAndBuildsAFreshOne() async throws {
        let model = makeModel()
        model.register(FakeExtension.self)
        let first = try remote(model, "two")
        let second = try remote(model, "three")

        await model.activate(first)
        let firstExtension = try #require(model.extension(FakeExtension.self))
        await model.activate(second)
        let secondExtension = try #require(model.extension(FakeExtension.self))

        #expect(firstExtension !== secondExtension)
        #expect(FakeExtension.ledger.created == 2)
        #expect(FakeExtension.ledger.tornDown == 1)
        #expect(FakeExtension.ledger.storeStillOwnedAtTeardown == [true])
        model.teardown()
    }

    @Test func registeringIsIdempotentAndBuildsImmediatelyWhenAStoreIsLive() async throws {
        let model = makeModel()
        await model.activate(try remote(model, "four"))

        model.register(FakeExtension.self)
        model.register(FakeExtension.self)

        #expect(model.extension(FakeExtension.self) != nil)
        #expect(FakeExtension.ledger.created == 1)
        model.teardown()
    }
}
