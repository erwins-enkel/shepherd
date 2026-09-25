import Foundation
import Observation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

/// A hand-driven stand-in for `SessionStore.connection`, so the connection
/// watcher's re-arm contract can be exercised without a server.
@Observable
@MainActor
final class ConnectionBox {
    var state: ConnectionState = .idle
}

/// Holds an injected async step open until the test says otherwise, so a
/// sign-in or sign-out can be caught mid-flight and a profile switch raced
/// against it.
@MainActor
final class Gate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var opened = false
    /// True once something is parked in `wait()`.
    private(set) var isWaiting = false

    func wait() async {
        if opened { return }
        isWaiting = true
        await withCheckedContinuation { self.continuation = $0 }
    }

    func open() {
        opened = true
        isWaiting = false
        continuation?.resume()
        continuation = nil
    }
}

/// `Gate`'s `Sendable` twin, for the injected `credentialProbe` — that seam is
/// a `@Sendable` closure, so what it holds cannot be main-actor-isolated.
actor ProbeHold {
    private var continuation: CheckedContinuation<Void, Never>?
    private var opened = false

    func wait() async {
        if opened { return }
        await withCheckedContinuation { continuation = $0 }
    }

    func open() {
        opened = true
        continuation?.resume()
        continuation = nil
    }
}

/// Yields until `condition` holds, bounded by a 10 s deadline rather than a
/// yield count (a loaded simulator can starve the awaited work for many hops);
/// an explicit `yields` keeps a count bound for checks that something does
/// *not* happen.
/// Reports whether it held. Everything under test is main-actor work that a yield lets run, so
/// there is nothing here to sleep for.
@MainActor
private func settle(until condition: () -> Bool, yields: Int? = nil) async -> Bool {
    if let yields {
        for _ in 0..<yields {
            if condition() { return true }
            await Task.yield()
        }
        return condition()
    }
    let deadline = ContinuousClock.now + .seconds(10)
    while ContinuousClock.now < deadline {
        if condition() { return true }
        await Task.yield()
    }
    return condition()
}

extension CoreSeamTests {
@MainActor
struct AppModelTests {
    private func makeModel(credentials: any CredentialStore = InMemoryCredentialStore()) -> AppModel {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return AppModel(defaults: defaults, credentials: credentials, notifications: CoreTestSupport.environment(defaults: defaults))
    }

    private func remote(_ model: AppModel, _ label: String) throws -> ServerProfile {
        try model.addRemoteProfile(name: label, address: "https://\(label).example.ts.net")
    }

    @Test func startsWithNoProfiles() {
        let model = makeModel()
        #expect(model.profiles.isEmpty)
        #expect(model.activeProfile == nil)
        #expect(model.store == nil)
    }

    @Test func addingARemoteProfileNormalisesTheAddress() throws {
        let model = makeModel()
        let profile = try model.addRemoteProfile(name: "Studio", address: "studio.example.ts.net/")
        #expect(profile.baseURL == URL(string: "https://studio.example.ts.net")!)
        #expect(profile.mode == .remote)
        #expect(profile.name == "Studio")
        #expect(model.profiles == [profile])
    }

    @Test func aBlankNameFallsBackToTheHost() throws {
        let model = makeModel()
        let profile = try model.addRemoteProfile(name: "   ", address: "https://studio.example.ts.net")
        #expect(profile.name == "studio.example.ts.net")
    }

    @Test func insecureAddressesAreRejectedAndNothingIsStored() {
        let model = makeModel()
        // The rejection comes from ShepherdKit's ServerProfile.validated(),
        // not from a second policy in this app.
        #expect(throws: ServerProfileError.insecureRemoteURL("studio.example.com")) {
            try model.addRemoteProfile(name: "Bad", address: "http://studio.example.com")
        }
        #expect(model.profiles.isEmpty)
    }

    @Test func plainHttpIsAllowedForLoopbackAndTailnetNames() throws {
        let model = makeModel()
        let loopback = try model.addRemoteProfile(name: "Local", address: "http://127.0.0.1:7330")
        #expect(loopback.baseURL == URL(string: "http://127.0.0.1:7330")!)
        let tailnet = try model.addRemoteProfile(name: "Box", address: "http://box.tail1234.ts.net")
        #expect(tailnet.baseURL == URL(string: "http://box.tail1234.ts.net")!)
    }

    @Test func aTsNetSuffixOnlyCountsOnALabelBoundary() {
        let model = makeModel()
        #expect(throws: ServerProfileError.insecureRemoteURL("evilts.net")) {
            try model.addRemoteProfile(name: "Evil", address: "http://evilts.net")
        }
    }

    @Test func blankAddressesAreAFormError() {
        let model = makeModel()
        #expect(throws: RemoteServerForm.FieldError.empty) {
            try model.addRemoteProfile(name: "Bad", address: "   \n ")
        }
        #expect(model.profiles.isEmpty)
    }

    @Test func nonHttpSchemesAreAFormError() {
        let model = makeModel()
        #expect(throws: RemoteServerForm.FieldError.malformed) {
            try model.addRemoteProfile(name: "Bad", address: "ws://box.example.ts.net")
        }
        #expect(throws: RemoteServerForm.FieldError.malformed) {
            try model.addRemoteProfile(name: "Bad", address: "https://")
        }
    }

    @Test func pathsQueriesAndCaseAreStrippedFromTheAddress() throws {
        let model = makeModel()
        let profile = try model.addRemoteProfile(
            name: "Studio", address: "HTTPS://BOX.Example.TS.NET/api/health?x=1")
        #expect(profile.baseURL == URL(string: "https://box.example.ts.net")!)
    }

    @Test func credentialKeysAreUniquePerProfile() throws {
        let model = makeModel()
        let a = try model.addRemoteProfile(name: "A", address: "https://a.example.ts.net")
        let b = try model.addRemoteProfile(name: "B", address: "https://b.example.ts.net")
        #expect(a.credentialKey != b.credentialKey)
        #expect(a.credentialKey.hasPrefix("run.shepherd.mac."))
    }

    @Test func theLocalProfilePointsAtLoopback7330() {
        let model = makeModel()
        let profile = model.addLocalProfile()
        #expect(profile.baseURL == URL(string: "http://127.0.0.1:7330")!)
        #expect(profile.mode == .local)
    }

    @Test func addingTheLocalProfileTwiceReusesTheSameRow() {
        let model = makeModel()
        let first = model.addLocalProfile()
        let second = model.addLocalProfile()
        #expect(first.id == second.id)
        #expect(model.profiles.count == 1)
    }

    @Test func profilesSurviveARestart() throws {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)

        let first = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        let profile = try first.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")

        let second = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        #expect(second.profiles == [profile])
    }

    @Test func removingAProfileDropsIt() async throws {
        let model = makeModel()
        model.logout = { _, _ in }
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")
        await model.remove(profile)
        #expect(model.profiles.isEmpty)
        #expect(model.activeProfile == nil)
        #expect(model.store == nil)
    }

    /// The old assertion ("not empty") also held for the `"0.0.0"` fallback, so
    /// it never proved the bundle was read at all.

    // MARK: - Removing a profile takes its credential with it

    @Test func removingAProfileRevokesAndDeletesItsToken() async throws {
        let credentials = InMemoryCredentialStore()
        let model = makeModel(credentials: credentials)
        var revoked: [String] = []
        model.logout = { profile, _ in revoked.append(profile.credentialKey) }

        let profile = try remote(model, "studio")
        try credentials.save(
            StoredCredential(token: "shp_secret", tokenId: "tok_1"), for: profile.credentialKey)

        await model.remove(profile)

        // Without this the random credentialKey dies with the row and the
        // Keychain item survives, un-revokable, next to a live server token.
        #expect(try credentials.load(for: profile.credentialKey) == nil)
        #expect(revoked == [profile.credentialKey])
        #expect(model.profiles.isEmpty)
    }

    @Test func removingTheActiveProfileTearsItsStoreDownFirst() async throws {
        let model = makeModel()
        let profile = try remote(model, "studio")
        // Reversing the order — logout before teardown — must fail this test:
        // assert the store is already gone from *inside* the injected logout.
        model.logout = { [weak model] _, _ in
            #expect(model?.store == nil, "the store must be torn down before logout runs")
        }
        await model.activate(profile)
        #expect(model.store != nil)

        await model.remove(profile)

        #expect(model.store == nil)
        #expect(model.activeProfile == nil)
        #expect(model.profiles.isEmpty)
    }

    // MARK: - Activation generation

    @Test func aSignInLandingAfterASwitchDoesNotStealTheActivation() async throws {
        let model = makeModel()
        let a = try remote(model, "a")
        let b = try remote(model, "b")
        let gate = Gate()
        model.login = { _, _, _ in await gate.wait() }

        let signIn = Task { try await model.signIn(profile: a, password: "hunter2") }
        #expect(await settle(until: { gate.isWaiting }))

        await model.activate(b)
        gate.open()
        try await signIn.value

        #expect(model.activeProfile == b)
        #expect(model.store?.client.profile.id == b.id)
        model.teardown()
    }

    @Test func aSignOutLandingAfterASwitchDoesNotTearDownTheNewStore() async throws {
        let model = makeModel()
        let a = try remote(model, "a")
        let b = try remote(model, "b")
        await model.activate(a)

        let gate = Gate()
        model.logout = { _, _ in await gate.wait() }
        let signOut = Task { await model.signOutActive() }
        #expect(await settle(until: { gate.isWaiting }))

        await model.activate(b)
        gate.open()
        let reported = await signOut.value

        #expect(model.activeProfile == b)
        #expect(model.store?.client.profile.id == b.id)
        // Nothing was torn down, so there is nothing to tell the operator about
        // a profile they have already left.
        #expect(reported == nil)
        model.teardown()
    }

    // MARK: - Sign-out reporting

    /// `signOutActive()` used to `try?` the revoke away, which left an operator
    /// believing a token was dead when the server had never confirmed it. The
    /// local sign-out still has to happen — a server that refuses must not trap
    /// the operator in the session — but the failure now comes back.
    @Test func aFailedRevokeIsReportedAndStillSignsOutLocally() async throws {
        struct RevokeRefused: Error, Equatable {}
        let model = makeModel()
        let a = try remote(model, "a")
        await model.activate(a)
        model.logout = { _, _ in throw RevokeRefused() }

        let reported = await model.signOutActive()

        #expect(reported as? RevokeRefused == RevokeRefused())
        #expect(model.activeProfile == nil)
        #expect(model.store == nil)
    }

    @Test func aCleanRevokeReportsNothing() async throws {
        let model = makeModel()
        let a = try remote(model, "a")
        await model.activate(a)
        model.logout = { _, _ in }

        let reported = await model.signOutActive()

        #expect(reported == nil)
        #expect(model.activeProfile == nil)
        #expect(model.store == nil)
    }

    @Test func signingOutWithNoActiveProfileIsANoOp() async {
        let model = makeModel()
        let reported = await model.signOutActive()
        #expect(reported == nil)
    }

    // MARK: - Removal races with activation

    /// Scenario A from the fix-wave-2 brief: a login sheet for B is submitted,
    /// `login` is in flight, and the operator removes B before it lands.
    /// Before the fix, `remove(_:)` never bumped `activationGeneration` for a
    /// profile that was never active, so the completing sign-in still matched
    /// and `activate(B)` resurrected a row this call had just deleted.
    /// S2 (fix wave 3): the injected `login` closure now actually saves a
    /// token into the `InMemoryCredentialStore`, the way `ProfileSetup.login`
    /// does — before the fix, `signIn`'s guard returned without cleaning that
    /// token up, orphaning it under a `credentialKey` no row owned any more.
    @Test func aSignInLandingAfterTheProfileWasRemovedDoesNotReviveIt() async throws {
        let credentials = InMemoryCredentialStore()
        let model = makeModel(credentials: credentials)
        model.logout = { _, _ in }
        let b = try remote(model, "b")

        let gate = Gate()
        model.login = { profile, _, credentialStore in
            await gate.wait()
            try credentialStore.save(
                StoredCredential(token: "shp_secret", tokenId: "tok_1"), for: profile.credentialKey)
        }

        let signIn = Task { try await model.signIn(profile: b, password: "hunter2") }
        #expect(await settle(until: { gate.isWaiting }))

        await model.remove(b)
        gate.open()
        try await signIn.value

        #expect(model.profiles.isEmpty)
        #expect(model.activeProfile == nil)
        #expect(model.store == nil)
        // S2: a login landing after its profile was removed must not leave
        // the token it just stored behind, orphaned and un-revokable.
        #expect(try credentials.load(for: b.credentialKey) == nil)
    }

    /// U1 (fix wave 4), variant 1: the common ordering the generation guard
    /// used to hide the removed-profile cleanup behind. `signIn(b)` parks in
    /// `login`, the operator activates `a` (bumping `activationGeneration`
    /// past what `signIn(b)` captured), then removes the still-inactive `b`
    /// (no bump — `b` was never active). Before the fix, `signIn`'s
    /// generation guard returned first on the mismatch and the removed-
    /// profile cleanup below it never ran, orphaning `b`'s freshly-stored
    /// token. The cleanup must run regardless of the generation mismatch,
    /// and `a`'s activation must be left alone.
    @Test func aSignInLandingAfterTheProfileWasRemovedDoesNotReviveItWhileAnotherProfileActivatedMeanwhile()
        async throws
    {
        let credentials = InMemoryCredentialStore()
        let model = makeModel(credentials: credentials)
        let a = try remote(model, "a")
        let b = try remote(model, "b")

        var loggedOut: [ServerProfile.ID] = []
        model.logout = { profile, _ in loggedOut.append(profile.id) }

        let gate = Gate()
        model.login = { profile, _, credentialStore in
            await gate.wait()
            try credentialStore.save(
                StoredCredential(token: "shp_secret", tokenId: "tok_1"), for: profile.credentialKey)
        }

        let signIn = Task { try await model.signIn(profile: b, password: "hunter2") }
        #expect(await settle(until: { gate.isWaiting }))

        await model.activate(a)
        await model.remove(b)
        gate.open()
        try await signIn.value

        #expect(model.activeProfile == a)
        #expect(try credentials.load(for: b.credentialKey) == nil)
        // Two revokes, not "at least one": `remove(_:)` makes one and the
        // sign-in completion's own cleanup makes the other. `contains` held
        // for either alone, so it could not fail for the bug it guards.
        #expect(loggedOut.filter { $0 == b.id }.count == 2)
        model.teardown()
    }

    /// U1 (fix wave 4), variant 2: `b` is itself the *active* profile when
    /// `signIn(b)` is launched, so `remove(b)` tears it down through
    /// `teardown()` — which *does* bump `activationGeneration`. Before the
    /// fix this also hit the generation guard first and returned without
    /// cleanup; the fix must clean up regardless of whether the generation
    /// happened to move too.
    @Test func aSignInLandingAfterItsOwnActiveProfileWasRemovedDoesNotReviveIt() async throws {
        let credentials = InMemoryCredentialStore()
        let model = makeModel(credentials: credentials)
        let b = try remote(model, "b")
        await model.activate(b)
        #expect(model.activeProfile == b)

        var loggedOut: [ServerProfile.ID] = []
        model.logout = { profile, _ in loggedOut.append(profile.id) }

        let gate = Gate()
        model.login = { profile, _, credentialStore in
            await gate.wait()
            try credentialStore.save(
                StoredCredential(token: "shp_secret", tokenId: "tok_1"), for: profile.credentialKey)
        }

        let signIn = Task { try await model.signIn(profile: b, password: "hunter2") }
        #expect(await settle(until: { gate.isWaiting }))

        await model.remove(b)
        gate.open()
        try await signIn.value

        #expect(model.activeProfile == nil)
        #expect(model.store == nil)
        #expect(try credentials.load(for: b.credentialKey) == nil)
        // Two revokes, not "at least one": `remove(_:)` makes one and the
        // sign-in completion's own cleanup makes the other. `contains` held
        // for either alone, so it could not fail for the bug it guards.
        #expect(loggedOut.filter { $0 == b.id }.count == 2)
    }

    /// S1 (fix wave 3): removing an *inactive* profile must not disturb the
    /// active profile's own connection watcher. The watcher is armed directly
    /// via the `ConnectionBox` seam, standing in for a real `activate(_:)` of
    /// `a` without a live server; what matters is that `remove(_:)` of `b`
    /// leaves `a`'s captured generation untouched.
    @Test func removingAnInactiveProfileDoesNotKillTheActiveWatcher() async throws {
        let model = makeModel()
        model.logout = { _, _ in }
        let a = try remote(model, "a")
        let b = try remote(model, "b")

        let box = ConnectionBox()
        model.watchConnection(
            ConnectionSource(read: { box.state }, abandon: {}),
            profile: a,
            generation: model.activationGeneration)

        await model.remove(b)

        box.state = .needsLogin
        #expect(await settle(until: { model.sheet == .login(a) }))
        model.teardown()
    }

    /// S3 (fix wave 3): removing an inactive profile whose `.login(_)` sheet
    /// is open must close that sheet — previously only `teardown()` (i.e.
    /// removing the *active* profile) cleared a profile-bound sheet.
    ///
    /// U3 (fix wave 4): `a` is a real, activated `SessionStore`, not a
    /// hand-driven `ConnectionBox`, so its watcher could legitimately route a
    /// fresh `.login(a)` while `remove(b)`'s awaited `logout` is in flight.
    /// Asserting `sheet == nil` would then flake on that race; the invariant
    /// this test actually cares about is only that `.login(b)` is gone.
    @Test func removingAnInactiveProfileWithAnOpenLoginSheetClosesIt() async throws {
        let model = makeModel()
        model.logout = { _, _ in }
        let a = try remote(model, "a")
        let b = try remote(model, "b")
        await model.activate(a)
        model.sheet = .login(b)

        await model.remove(b)

        #expect(model.sheet != .login(b))
        model.teardown()
    }

    /// Scenario B from the fix-wave-2 brief: B is active, `remove(_:)` tears
    /// its store down and is then held mid-flight inside the gated `logout`
    /// — B is still in `profiles` at this point, removal has not reached
    /// `profiles.removeAll` yet. Re-activating B here must be refused, or it
    /// would install a replacement store for a row `remove(_:)` is about to
    /// delete.
    @Test func reactivatingAProfileMidRemovalIsRefused() async throws {
        let model = makeModel()
        let b = try remote(model, "b")
        await model.activate(b)
        #expect(model.store != nil)

        let gate = Gate()
        model.logout = { _, _ in await gate.wait() }
        let remove = Task { await model.remove(b) }
        #expect(await settle(until: { gate.isWaiting }))

        // b is still listed here — remove() has not reached
        // profiles.removeAll — but reactivation must already be refused.
        #expect(model.profiles.contains(where: { $0.id == b.id }))
        await model.activate(b)
        #expect(model.store == nil)
        #expect(model.activeProfile == nil)

        gate.open()
        await remove.value

        #expect(model.profiles.isEmpty)
        #expect(model.store == nil)
        #expect(model.activeProfile == nil)
    }

    // MARK: - Profile-bound sheets

    @Test func activatingAnotherProfileClosesTheOldLoginSheet() async throws {
        let model = makeModel()
        let a = try remote(model, "a")
        let b = try remote(model, "b")
        model.sheet = .login(a)

        await model.activate(b)

        // A stale .login(a) would both block b's own routing and, if submitted,
        // authenticate a and switch back.
        #expect(model.sheet == nil)
        model.routeSheet(for: .needsLogin, profile: b)
        #expect(model.sheet == .login(b))
        model.teardown()
    }

    @Test func aWindowBoundSheetSurvivesAProfileSwitch() async throws {
        let model = makeModel()
        let a = try remote(model, "a")
        let b = try remote(model, "b")
        _ = a
        model.sheet = .newSession

        await model.activate(b)

        #expect(model.sheet == .newSession)
        model.teardown()
    }

    @Test func aFailedActivationLeavesNoSheetOverTheWelcomeScreen() async {
        // The shape only an older build could have persisted: plain http to a
        // public host, which SessionStore.init refuses. `activate(_:)` now
        // requires the profile to actually be listed, so it is seeded straight
        // into UserDefaults — as `ProfileStore.save` (no validation) would have
        // left it — rather than added through `addRemoteProfile`, which would
        // reject it.
        let stale = ServerProfile(
            id: UUID(),
            name: "Old",
            baseURL: URL(string: "http://studio.example.com")!,
            mode: .remote,
            credentialKey: "run.shepherd.mac.stale")
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        ProfileStore(defaults: defaults).save(profiles: [stale], activeID: nil)

        let model = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        model.sheet = .firstRun

        await model.activate(stale)

        #expect(model.store == nil)
        #expect(model.activeProfile == nil)
        #expect(model.sheet == nil)
    }

    // MARK: - Releasing the model releases the store

    @Test func droppingTheModelReleasesItsSessionStore() async throws {
        weak var released: SessionStore?
        do {
            let model = makeModel()
            let profile = try remote(model, "studio")
            await model.activate(profile)
            released = model.store
            #expect(released != nil)
        }
        // Tasks that captured the store strongly would keep it — and its
        // EventStream — reconnecting long after the window closed.
        #expect(await settle(until: { released == nil }))
    }

    // MARK: - The connection watcher, driven by observation

    @Test func theWatcherReArmsAfterEveryChangeAndStopsAfterTeardown() async throws {
        let model = makeModel()
        let profile = try remote(model, "studio")
        let box = ConnectionBox()
        model.watchConnection(
            ConnectionSource(read: { box.state }, abandon: {}),
            profile: profile,
            generation: model.activationGeneration)

        // Change 1 is the initial read: .idle opens nothing.
        #expect(model.sheet == nil)

        box.state = .needsLogin
        #expect(await settle(until: { model.sheet == .login(profile) }))

        model.sheet = nil
        box.state = .firstRunPending
        #expect(await settle(until: { model.sheet == .firstRun }))

        model.sheet = nil
        box.state = .needsLogin
        #expect(await settle(until: { model.sheet == .login(profile) }))

        model.teardown()
        box.state = .firstRunPending
        _ = await settle(until: { model.sheet != nil }, yields: 50)
        #expect(model.sheet == nil)
    }

    /// S1's review handed S0-int this one: `teardown()` cancels the watcher, and cancellation
    /// alone never resumes a suspended `withCheckedContinuation`. Only a *further* write to
    /// `SessionStore.connection` could, and `stop()` publishes `.idle` only when the state is not
    /// already `.idle` — so a watcher parked on a quiet connection stayed parked for the life of
    /// the process, once per profile switch, holding its `ConnectionSource` and an observation
    /// registration inside the store. The `AsyncStream` shape is finishable, so `teardown()` ends
    /// the loop for real and the model goes with it.
    ///
    /// Mirrors `DetailModelTests.teardownEndsTheSessionsWatcher`.
    @Test func teardownEndsTheConnectionWatcherAndReleasesTheModel() async throws {
        let box = ConnectionBox()
        weak var released: AppModel?
        do {
            let model = makeModel()
            let profile = try remote(model, "studio")
            model.watchConnection(
                ConnectionSource(read: { box.state }, abandon: {}),
                profile: profile,
                generation: model.activationGeneration)
            #expect(model.isWatchingConnection)

            // Park it: route the initial `.idle`, then one real change, so the loop is
            // demonstrably suspended waiting for the next one when teardown arrives.
            box.state = .needsLogin
            #expect(await settle(until: { model.sheet == .login(profile) }))

            model.teardown()
            #expect(await settle(until: { model.isWatchingConnection == false }))

            // The connection never changes again — exactly the case the old shape could not
            // survive.
            released = model
        }
        #expect(await settle(until: { released == nil }))
    }

    /// Re-arming must not let the *outgoing* watcher report the loop gone.
    ///
    /// The replacement installs itself synchronously, while the predecessor is
    /// still suspended; the predecessor then wakes on its finished stream and
    /// runs its cleanup. `isWatchingConnection` is this branch's regression
    /// guard for the `AsyncStream` fix, so a false `false` here would make the
    /// guard lie about a watcher that is still alive.
    @Test func rearmingTheWatcherLeavesTheReplacementReportingItself() async throws {
        let model = makeModel()
        let profile = try remote(model, "studio")
        let box = ConnectionBox()

        model.watchConnection(
            ConnectionSource(read: { box.state }, abandon: {}),
            profile: profile,
            generation: model.activationGeneration)
        #expect(model.isWatchingConnection)

        // Arm a second watcher over the top, then give the first one every
        // chance to unwind and clear the flag it no longer owns.
        model.watchConnection(
            ConnectionSource(read: { box.state }, abandon: {}),
            profile: profile,
            generation: model.activationGeneration)
        _ = await settle(until: { model.isWatchingConnection == false }, yields: 200)
        #expect(model.isWatchingConnection)

        // And the live watcher still answers to teardown.
        model.teardown()
        #expect(await settle(until: { model.isWatchingConnection == false }))
    }

    @Test func theWatcherIgnoresStatesFromAnOlderActivation() async throws {
        let model = makeModel()
        let profile = try remote(model, "studio")
        let box = ConnectionBox()
        // Already `.needsLogin` *before* the watcher is armed, so the old
        // (pre-fix) code — which routed the initial read outside the
        // generation guard — would have opened the login sheet right away.
        // This must still pass only because the guard now covers that read.
        box.state = .needsLogin
        model.watchConnection(
            ConnectionSource(read: { box.state }, abandon: {}),
            profile: profile,
            generation: model.activationGeneration - 1)

        _ = await settle(until: { model.sheet != nil }, yields: 50)
        #expect(model.sheet == nil)
        model.teardown()
    }

    // MARK: - Connection routing

    @Test func needsLoginRoutesToTheLoginSheet() throws {
        let model = makeModel()
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")
        model.routeSheet(for: .needsLogin, profile: profile)
        #expect(model.sheet == .login(profile))
    }

    @Test func firstRunPendingRoutesToTheFolderPicker() throws {
        let model = makeModel()
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")
        model.routeSheet(for: .firstRunPending, profile: profile)
        #expect(model.sheet == .firstRun)
    }

    @Test func quietStatesOpenNoSheet() throws {
        let model = makeModel()
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")
        for state: ConnectionState in [.idle, .connecting, .live, .offline(message: "timed out")] {
            model.sheet = nil
            model.routeSheet(for: state, profile: profile)
            #expect(model.sheet == nil, "\(state) should not open a sheet")
        }
    }

    @Test func anOpenSheetIsNotReplaced() throws {
        let model = makeModel()
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")
        model.sheet = .newSession
        model.routeSheet(for: .needsLogin, profile: profile)
        #expect(model.sheet == .newSession)
    }

    // MARK: - Re-routing when a window-bound sheet closes

    /// X1: `.newSession` is window-bound, so it survives everything the
    /// connection does — and while it is up `routeSheet` refuses to replace it.
    /// A token that expires mid-sheet therefore lands `.needsLogin` on a state
    /// nobody routes: the watcher has already fired for it and will not fire
    /// again for a state that has not changed, and Cancel only clears the
    /// sheet. The operator was left on a main window with no way back in.
    @Test func closingAWindowBoundSheetRoutesTheCurrentConnectionState() async throws {
        let model = makeModel()
        let profile = try remote(model, "studio")
        let box = ConnectionBox()
        model.watchConnection(
            ConnectionSource(read: { box.state }, abandon: {}),
            profile: profile,
            generation: model.activationGeneration)

        model.sheet = .newSession
        box.state = .needsLogin
        // The create sheet holds the floor: routing must not replace it.
        _ = await settle(until: { model.sheet != .newSession }, yields: 50)
        #expect(model.sheet == .newSession)

        // Cancel.
        model.sheet = nil

        #expect(model.sheet == .login(profile))
        model.teardown()
    }

    /// The other half of the rule: a profile-bound sheet is routed *for* the
    /// state it is showing, so re-routing when it closes would put it straight
    /// back up and the operator could never dismiss the login sheet.
    @Test func closingTheLoginSheetOnAnUnchangedStateDoesNotReopenIt() async throws {
        let model = makeModel()
        let profile = try remote(model, "studio")
        let box = ConnectionBox()
        box.state = .needsLogin
        model.watchConnection(
            ConnectionSource(read: { box.state }, abandon: {}),
            profile: profile,
            generation: model.activationGeneration)
        #expect(await settle(until: { model.sheet == .login(profile) }))

        model.sheet = nil

        #expect(model.sheet == nil)
        model.teardown()
    }

    @Test func closingASheetOnAHealthyConnectionOpensNothing() async throws {
        let model = makeModel()
        let profile = try remote(model, "studio")
        let box = ConnectionBox()
        box.state = .live
        model.watchConnection(
            ConnectionSource(read: { box.state }, abandon: {}),
            profile: profile,
            generation: model.activationGeneration)

        model.sheet = .newSession
        model.sheet = nil

        #expect(model.sheet == nil)
        model.teardown()
    }

    /// The re-route reads the activation's own connection source, so an
    /// activation that has ended has nothing to re-route from: a sheet closing
    /// over the welcome screen must not resurrect a login sheet for a profile
    /// the operator has left.
    @Test func closingASheetAfterTeardownOpensNothing() async throws {
        let model = makeModel()
        let profile = try remote(model, "studio")
        let box = ConnectionBox()
        box.state = .needsLogin
        model.watchConnection(
            ConnectionSource(read: { box.state }, abandon: {}),
            profile: profile,
            generation: model.activationGeneration)
        model.teardown()

        model.sheet = .newSession
        model.sheet = nil

        #expect(model.sheet == nil)
    }

    // MARK: - Selection reconciliation

    /// X3: the selection was cleared only when *this* window's archive
    /// succeeded, so a session archived elsewhere — the row arrives gone over
    /// the event stream — left `selectedSessionID` pointing at nothing, with
    /// the toolbar's session commands still enabled for it.
    @Test func aSelectionWhoseSessionIsGoneIsCleared() {
        let model = makeModel()
        model.selectedSessionID = "s-1"
        model.reconcileSelection(against: ["s-2", "s-3"])
        #expect(model.selectedSessionID == nil)
    }

    @Test func aSelectionThatIsStillListedSurvives() {
        let model = makeModel()
        model.selectedSessionID = "s-1"
        model.reconcileSelection(against: ["s-1", "s-2"])
        #expect(model.selectedSessionID == "s-1")
    }

    @Test func reconcilingWithNoSelectionDoesNothing() {
        let model = makeModel()
        model.reconcileSelection(against: [])
        #expect(model.selectedSessionID == nil)
    }

    // MARK: - Sign-out reporting lives in the model

    /// X5: the mapping from a failed revoke to operator-facing copy used to sit
    /// inline in `MainWindow`, where no unit test could reach it.
    @Test func aFailedRevokeWritesTheSignOutWarning() async throws {
        struct RevokeRefused: Error {}
        let model = makeModel()
        let a = try remote(model, "a")
        await model.activate(a)
        model.logout = { _, _ in throw RevokeRefused() }

        await model.signOutActiveReporting()

        #expect(
            model.signOutWarning
                == L.t("native_signout_failed", ShepherdErrorCopy.message(RevokeRefused())))
        #expect(model.activeProfile == nil)
        #expect(model.store == nil)
    }

    @Test func aCleanRevokeWritesNoWarning() async throws {
        let model = makeModel()
        let a = try remote(model, "a")
        await model.activate(a)
        model.logout = { _, _ in }

        await model.signOutActiveReporting()

        #expect(model.signOutWarning == nil)
        #expect(model.activeProfile == nil)
    }

    // MARK: - Notices do not survive a profile switch

    /// X6: the warning names the profile the operator just left. Carrying it
    /// over the next activation tells them a server they are now signed in to
    /// failed to sign them out.
    @Test func activatingAnotherProfileClearsTheSignOutWarning() async throws {
        let model = makeModel()
        let a = try remote(model, "a")
        let b = try remote(model, "b")
        await model.activate(a)
        model.signOutWarning = "stale"

        await model.activate(b)

        #expect(model.signOutWarning == nil)
        model.teardown()
    }

    @Test func tearingDownClearsTheSignOutWarning() async throws {
        let model = makeModel()
        let a = try remote(model, "a")
        await model.activate(a)
        model.signOutWarning = "stale"

        model.teardown()

        #expect(model.signOutWarning == nil)
    }

    // MARK: - Parking a profile without revoking its token

    /// X2: "Add server…" used to go through `signOutActive()`, because a stored
    /// profile was unreachable from the welcome screen and a token left under a
    /// row nobody could get back to is the orphaned credential `remove(_:)`
    /// exists to prevent. The welcome screen lists saved servers now, so adding
    /// another server must *park* the current one — revoking here would make
    /// every "add a server" a silent sign-out of the one already set up.
    @Test func deactivatingKeepsTheTokenAndClearsTheActiveProfile() async throws {
        let credentials = InMemoryCredentialStore()
        let model = makeModel(credentials: credentials)
        var revoked = 0
        model.logout = { _, _ in revoked += 1 }
        let a = try remote(model, "a")
        try credentials.save(
            StoredCredential(token: "shp_secret", tokenId: "tok_1"), for: a.credentialKey)
        await model.activate(a)

        model.deactivate()

        #expect(revoked == 0)
        #expect(try credentials.load(for: a.credentialKey)?.token == "shp_secret")
        #expect(model.activeProfile == nil)
        #expect(model.store == nil)
        #expect(model.profiles == [a])
    }

    @Test func deactivatingForgetsTheActiveProfileAcrossARestart() async throws {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        let model = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        let a = try model.addRemoteProfile(name: "a", address: "https://a.example.ts.net")
        await model.activate(a)

        model.deactivate()

        let restarted = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        #expect(restarted.profiles == [a])
        #expect(restarted.activeProfile == nil)
    }

    // MARK: - Saved servers on the welcome screen

    /// The welcome screen's list is data-driven from `profiles`. "Run on this
    /// Mac" has its own card that probes for a live local server, so the local
    /// row would be a second, dumber way to start the same thing.
    @Test func savedServersListsTheRemoteProfilesOnly() throws {
        let model = makeModel()
        let local = model.addLocalProfile()
        let a = try remote(model, "a")
        let b = try remote(model, "b")

        #expect(model.savedServers == [a, b])
        #expect(!model.savedServers.contains(local))
    }

    @Test func savedServersIsEmptyWithoutARemoteProfile() {
        let model = makeModel()
        _ = model.addLocalProfile()
        #expect(model.savedServers.isEmpty)
    }

    // MARK: - The welcome screen's logins go through the one sheet channel

    /// B1 (whole-branch wave): `WelcomeView` used to present its own
    /// `LoginSheet` from a view-local `pendingLogin` — a second sheet channel,
    /// parallel to `RootView`'s single presenter and outside every AppModel
    /// invariant. On success `activate(_:)` swapped Welcome → MainWindow
    /// *under* that presented sheet while the new watcher routed `.firstRun`;
    /// AppKit refuses a second modal, so `sheet` stayed `.firstRun` with
    /// nothing on screen and routing never fired again. Both welcome paths now
    /// write `model.sheet`, which the one presenter shows.
    @Test func connectingToThisMacRoutesItsLoginThroughTheModelsSheet() {
        let model = makeModel()
        let profile = model.beginLocalLogin()
        #expect(model.sheet == .login(profile))
        #expect(model.profiles == [profile])
    }

    @Test func connectingToANewRemoteServerRoutesItsLoginThroughTheModelsSheet() throws {
        let model = makeModel()
        let profile = try model.beginRemoteLogin(name: "Studio", address: "studio.example.ts.net")
        #expect(model.sheet == .login(profile))
        #expect(model.profiles == [profile])
    }

    @Test func anAddressTheKitRejectsOpensNoSheet() {
        let model = makeModel()
        #expect(throws: ServerProfileError.insecureRemoteURL("studio.example.com")) {
            try model.beginRemoteLogin(name: "Bad", address: "http://studio.example.com")
        }
        #expect(model.sheet == nil)
        #expect(model.profiles.isEmpty)
    }

    /// The end of the same story: a login that succeeds leaves the one sheet
    /// channel free, so the `.firstRun` the new activation's watcher routes is
    /// actually presented — `.login` → nil → `.firstRun`, with `routeSheet`
    /// running because `sheet` is nil rather than still holding a login sheet
    /// nobody can see.
    @Test func aFirstRunRoutedAfterASuccessfulLoginIsPresented() async throws {
        let model = makeModel()
        model.login = { _, _, _ in }
        let profile = try model.beginRemoteLogin(
            name: "Studio", address: "https://studio.example.ts.net")
        #expect(model.sheet == .login(profile))

        try await model.signIn(profile: profile, password: "hunter2")

        // The activation cleared the profile-bound sheet on its way in.
        #expect(model.sheet == nil)

        let box = ConnectionBox()
        model.watchConnection(
            ConnectionSource(read: { box.state }, abandon: {}),
            profile: profile,
            generation: model.activationGeneration)
        box.state = .firstRunPending

        #expect(await settle(until: { model.sheet == .firstRun }))
        model.teardown()
    }

    // MARK: - Removal is not re-entrant

    /// B2 (whole-branch wave): the welcome screen's Remove fires a `Task` per
    /// click, so two clicks used to start two removals of the same row. The
    /// second one re-ran the whole sequence — a second `teardown()`, a second
    /// server-side revoke of a token the first call had already revoked — on a
    /// row that was on its way out.
    @Test func aSecondRemoveOfTheSameProfileIsIgnoredWhileTheFirstIsInFlight() async throws {
        let model = makeModel()
        let profile = try remote(model, "studio")
        var revokes = 0
        let gate = Gate()
        model.logout = { _, _ in
            revokes += 1
            // Only the first call parks, so an unguarded second call fails this
            // test on the count instead of hanging it.
            if revokes == 1 { await gate.wait() }
        }

        let first = Task { await model.remove(profile) }
        #expect(await settle(until: { gate.isWaiting }))

        await model.remove(profile)
        #expect(revokes == 1)

        gate.open()
        await first.value

        #expect(revokes == 1)
        #expect(model.profiles.isEmpty)
    }

    // MARK: - A saved server is not added twice

    /// B8: typing the address of a server that is already saved appended a
    /// second row with a fresh `credentialKey`, so `savedServers` accumulated
    /// orphans — and the original row's token stayed live under a row the
    /// operator could no longer tell apart.
    @Test func addingAnAddressThatIsAlreadySavedReusesThatRow() throws {
        let model = makeModel()
        let saved = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")

        let again = try model.addRemoteProfile(
            name: "Studio again", address: "STUDIO.Example.TS.NET/api/health?x=1")

        #expect(again.id == saved.id)
        #expect(again.credentialKey == saved.credentialKey)
        #expect(model.profiles == [saved])
        #expect(model.savedServers.count == 1)
    }

    @Test func connectingToAnAddressThatIsAlreadySavedLogsIntoThatRow() throws {
        let model = makeModel()
        let saved = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")

        let again = try model.beginRemoteLogin(name: "", address: "studio.example.ts.net")

        #expect(again.id == saved.id)
        #expect(model.sheet == .login(saved))
        #expect(model.profiles == [saved])
    }

    @Test func aDifferentAddressStillAddsItsOwnRow() throws {
        let model = makeModel()
        let a = try remote(model, "a")
        let b = try remote(model, "b")
        #expect(model.profiles == [a, b])
    }

    /// The local card owns loopback; a remote row that happens to point at the
    /// same URL must not be swallowed by it, and vice versa.
    @Test func theLocalProfileIsNotDedupedAgainstARemoteRow() throws {
        let model = makeModel()
        let local = model.addLocalProfile()
        let remoteLoopback = try model.addRemoteProfile(name: "Loopback", address: "http://127.0.0.1:7330")
        #expect(remoteLoopback.id != local.id)
        #expect(model.profiles.count == 2)
    }

    // MARK: - Relaunching reconnects the restored profile

    /// B5: `init` restores `activeProfile` from `UserDefaults` but starts no
    /// store, so a relaunch came up with a profile "active" and nothing behind
    /// it — the main window rendered against a `nil` store, no watcher was
    /// armed and no sheet could ever be routed. The launch task reconnects it;
    /// a missing credential is then the watcher's problem, and it routes
    /// `.login`.
    @Test func theRestoredActiveProfileIsReconnectedOnLaunch() async throws {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        let profile = ServerProfile(
            id: UUID(),
            name: "Studio",
            baseURL: URL(string: "https://studio.example.ts.net")!,
            mode: .remote,
            credentialKey: "run.shepherd.mac.restored")
        ProfileStore(defaults: defaults).save(profiles: [profile], activeID: profile.id)

        let model = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        #expect(model.activeProfile == profile)
        #expect(model.store == nil)

        await model.restoreActiveProfile()

        #expect(model.activeProfile == profile)
        #expect(model.store != nil)
        #expect(model.store?.client.profile.id == profile.id)
        model.teardown()
    }

    /// The launch task runs once per window appearance, and a second run must
    /// not tear a live activation down and build it again.
    @Test func restoringTwiceKeepsTheStoreThatIsAlreadyRunning() async throws {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        let profile = ServerProfile(
            id: UUID(),
            name: "Studio",
            baseURL: URL(string: "https://studio.example.ts.net")!,
            mode: .remote,
            credentialKey: "run.shepherd.mac.restored")
        ProfileStore(defaults: defaults).save(profiles: [profile], activeID: profile.id)
        let model = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        await model.restoreActiveProfile()
        let running = model.store

        await model.restoreActiveProfile()

        #expect(model.store === running)
        model.teardown()
    }

    @Test func restoringWithNoPersistedActiveProfileStartsNothing() async {
        let model = makeModel()
        await model.restoreActiveProfile()
        #expect(model.store == nil)
        #expect(model.activeProfile == nil)
    }

    /// The launch task is not first by contract. A Connect for a *different*
    /// server writes `sheet = .login(that one)` and leaves `activeProfile`
    /// alone, so a restore running afterwards would activate the persisted
    /// profile and clear the sheet the operator just asked for.
    @Test func restoringDoesNotOverruleALoginTheOperatorAlreadyAskedFor() async throws {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        let persisted = ServerProfile(
            id: UUID(),
            name: "Studio",
            baseURL: URL(string: "https://studio.example.ts.net")!,
            mode: .remote,
            credentialKey: "run.shepherd.mac.restored")
        ProfileStore(defaults: defaults).save(profiles: [persisted], activeID: persisted.id)
        let model = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))

        let chosen = try model.beginRemoteLogin(name: "Loft", address: "https://loft.example.ts.net")
        await model.restoreActiveProfile()

        #expect(model.sheet == .login(chosen))
        #expect(model.store == nil)
    }

    /// K1: the stopped old store must not stay published while a new
    /// activation's credential pre-flight is in flight. Before the fix,
    /// `store` still pointed at A's stopped `SessionStore` while
    /// `activeProfile` already read B — `RootView` would keep `MainWindow`
    /// mounted on A's dead store, showing B's title over A's content, and an
    /// `isCurrent: { model.store === store }` check would fire against the
    /// server the operator had just left.
    @Test func activatingDropsTheOldStoreBeforeTheCredentialProbeSettles() async throws {
        let model = makeModel()
        let a = try remote(model, "alpha")
        let b = try remote(model, "bravo")
        await model.activate(a)
        let previousStore = model.store
        #expect(previousStore != nil)

        let held = ProbeHold()
        model.credentialProbe = { _, _ in await held.wait() }
        let activation = Task { await model.activate(b) }
        // `activeProfile` flips to `b` synchronously, before the pre-flight's
        // only suspension point, so observing it here is observing the
        // mid-flight state the probe is holding open.
        #expect(await settle(until: { model.activeProfile == b }))

        #expect(model.store == nil)
        #expect(model.activeProfile == b)

        await held.open()
        await activation.value

        #expect(model.store != nil)
        #expect(model.store !== previousStore)
        #expect(model.activeProfile == b)
        model.teardown()
    }

    /// The regression this file exists for: a Keychain read that never returns
    /// used to leave the operator on a main window with an empty sidebar, no
    /// banner and no sheet, for as long as they waited. `activate(_:)` now
    /// bounds that read and asks for a fresh sign-in instead — which is also
    /// what repairs the stored item.
    @Test func aKeychainThatNeverAnswersAsksForAFreshSignInInsteadOfHanging() async throws {
        let model = makeModel()
        let profile = try remote(model, "studio")
        let held = ProbeHold()
        model.credentialProbe = { _, _ in await held.wait() }
        model.credentialTimeout = .milliseconds(20)

        await model.activate(profile)

        #expect(model.store == nil)
        #expect(model.activeProfile == nil)
        #expect(model.sheet == .login(profile))
        await held.open()
    }

    /// The same pre-flight must be invisible when the Keychain behaves: a store
    /// is built, exactly as before.
    @Test func aKeychainThatAnswersActivatesNormally() async throws {
        let model = makeModel()
        let profile = try remote(model, "studio")
        // No `credentialTimeout` override: the default `credentialProbe` hops
        // to a real thread, and a tight budget here raced it against
        // scheduling rather than against Keychain behaviour.

        await model.activate(profile)

        #expect(model.store != nil)
        #expect(model.activeProfile == profile)
        #expect(model.sheet == nil)
        model.teardown()
    }
}
}
