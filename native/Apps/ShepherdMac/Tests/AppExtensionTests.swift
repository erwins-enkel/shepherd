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


/// Records creation/teardown order across two distinct `AppExtension` types, so
/// a test can see how they interleave rather than each type's own count.
@MainActor
final class OrderLedger {
    static var shared = OrderLedger()
    var events: [String] = []
}

@MainActor
final class FirstFakeExtension: AppExtension {
    init(store: SessionStore, app: AppModel) { OrderLedger.shared.events.append("first.created") }
    func teardown() { OrderLedger.shared.events.append("first.torn") }
}

@MainActor
final class SecondFakeExtension: AppExtension {
    init(store: SessionStore, app: AppModel) { OrderLedger.shared.events.append("second.created") }
    func teardown() { OrderLedger.shared.events.append("second.torn") }
}

/// Yields until `condition` holds or the budget runs out, and reports whether it
/// held. Everything under test is main-actor work a yield lets run, so there is
/// nothing here to sleep for. A file-local twin of `AppModelTests`' own helper,
/// which is `private` to that file.
@MainActor
private func settle(until condition: () -> Bool, yields: Int = 500) async -> Bool {
    for _ in 0..<yields {
        if condition() { return true }
        await Task.yield()
    }
    return condition()
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

    /// The activation-generation guard, from the extensions' side. `activate(_:)`
    /// suspends on the credential pre-flight, and a `teardown()` that lands while
    /// it waits owns the model from then on: the late completion must build no
    /// extension, because the store it would have been given never exists.
    @Test func anActivationSupersededOnTheCredentialProbeBuildsNoExtension() async throws {
        let model = makeModel()
        model.register(FakeExtension.self)
        let first = try remote(model, "five")
        let second = try remote(model, "six")
        await model.activate(first)
        #expect(FakeExtension.ledger.created == 1)

        let held = ProbeHold()
        model.credentialProbe = { _, _ in await held.wait() }
        let activation = Task { await model.activate(second) }
        // `activate(_:)` drops the old store before its only suspension point, so
        // this is the mid-probe state — and the first extension is already gone,
        // torn down while that store was still published.
        #expect(await settle(until: { model.store == nil }))
        #expect(FakeExtension.ledger.tornDown == 1)
        #expect(FakeExtension.ledger.storeStillOwnedAtTeardown == [true])
        #expect(model.extension(FakeExtension.self) == nil)

        // Bumps the generation the parked activation captured.
        model.teardown()
        await held.open()
        await activation.value

        #expect(model.store == nil)
        #expect(model.extension(FakeExtension.self) == nil)
        #expect(FakeExtension.ledger.created == 1)
        #expect(FakeExtension.ledger.tornDown == 1)
    }

    /// The other exit from the pre-flight: the Keychain never answers, the
    /// activation asks for a fresh sign-in instead of connecting, and there is no
    /// store — so there must be no extension either.
    @Test func aKeychainThatNeverAnswersBuildsNoExtension() async throws {
        let model = makeModel()
        model.register(FakeExtension.self)
        let profile = try remote(model, "seven")
        let held = ProbeHold()
        model.credentialProbe = { _, _ in await held.wait() }
        model.credentialTimeout = .milliseconds(20)

        await model.activate(profile)

        #expect(model.store == nil)
        #expect(model.sheet == .login(profile))
        #expect(model.extension(FakeExtension.self) == nil)
        #expect(FakeExtension.ledger.created == 0)
        #expect(FakeExtension.ledger.tornDown == 0)
        await held.open()
    }

    /// Removing the active profile ends its activation through `teardown()`, so
    /// the extension goes with it — still holding a store the model has not let
    /// go of yet.
    @Test func removingTheActiveProfileTearsTheExtensionDown() async throws {
        let model = makeModel()
        model.register(FakeExtension.self)
        model.logout = { _, _ in }
        let profile = try remote(model, "eight")
        await model.activate(profile)
        #expect(model.extension(FakeExtension.self) != nil)

        await model.remove(profile)

        #expect(model.extension(FakeExtension.self) == nil)
        #expect(FakeExtension.ledger.tornDown == 1)
        #expect(FakeExtension.ledger.storeStillOwnedAtTeardown == [true])
    }

    /// `teardown()` is the app's idle state, and a view task may reach it twice.
    /// Every live instance is torn down exactly once.
    @Test func aSecondTeardownTearsNothingDownTwice() async throws {
        let model = makeModel()
        model.register(FakeExtension.self)
        await model.activate(try remote(model, "nine"))

        model.teardown()
        model.teardown()

        #expect(FakeExtension.ledger.created == 1)
        #expect(FakeExtension.ledger.tornDown == 1)
    }

    /// Registration survives the activation it was made during: the factory is
    /// kept, so the next activation builds a fresh instance without re-registering.
    @Test func aTypeRegisteredMidActivationIsRebuiltByTheNextOne() async throws {
        let model = makeModel()
        let first = try remote(model, "ten")
        let second = try remote(model, "eleven")
        await model.activate(first)
        model.register(FakeExtension.self)
        let built = try #require(model.extension(FakeExtension.self))

        await model.activate(second)

        let rebuilt = try #require(model.extension(FakeExtension.self))
        #expect(rebuilt !== built)
        #expect(rebuilt.store === model.store)
        #expect(FakeExtension.ledger.created == 2)
        #expect(FakeExtension.ledger.tornDown == 1)
        model.teardown()
    }

    /// Two extension types sharing one ledger: creation follows registration
    /// order, teardown reverses it — the later-built extension, which may
    /// depend on the earlier one, goes first.
    @Test func twoExtensionsAreBuiltInRegistrationOrderAndTornDownInReverse() async throws {
        let model = makeModel()
        OrderLedger.shared = OrderLedger()
        model.register(FirstFakeExtension.self)
        model.register(SecondFakeExtension.self)

        await model.activate(try remote(model, "twelve"))
        #expect(OrderLedger.shared.events == ["first.created", "second.created"])

        model.teardown()
        #expect(
            OrderLedger.shared.events == [
                "first.created", "second.created", "second.torn", "first.torn",
            ])
    }
}
