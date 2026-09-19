import Foundation
import Observation
import Testing
import ShepherdKit
@testable import Shepherd

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

/// Yields until `condition` holds or the budget runs out, and reports whether
/// it held. Everything under test is main-actor work that a yield lets run, so
/// there is nothing here to sleep for.
@MainActor
private func settle(until condition: () -> Bool, yields: Int = 500) async -> Bool {
    for _ in 0..<yields {
        if condition() { return true }
        await Task.yield()
    }
    return condition()
}

@MainActor
struct AppModelTests {
    private func makeModel(credentials: any CredentialStore = InMemoryCredentialStore()) -> AppModel {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return AppModel(defaults: defaults, credentials: credentials)
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

        let first = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        let profile = try first.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")

        let second = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
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
    @Test func appVersionIsTheBundlesShortVersionString() throws {
        let fromBundle = try #require(
            Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
        #expect(fromBundle != "0.0.0", "the test host must carry a real MARKETING_VERSION")
        #expect(makeModel().appVersion == fromBundle)
    }

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
        model.logout = { _, _ in }
        let profile = try remote(model, "studio")
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
        await signOut.value

        #expect(model.activeProfile == b)
        #expect(model.store?.client.profile.id == b.id)
        model.teardown()
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
        let model = makeModel()
        // The shape only an older build could have persisted: plain http to a
        // public host, which SessionStore.init refuses.
        let stale = ServerProfile(
            id: UUID(),
            name: "Old",
            baseURL: URL(string: "http://studio.example.com")!,
            mode: .remote,
            credentialKey: "run.shepherd.mac.stale")
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

    @Test func theWatcherIgnoresStatesFromAnOlderActivation() async throws {
        let model = makeModel()
        let profile = try remote(model, "studio")
        let box = ConnectionBox()
        model.watchConnection(
            ConnectionSource(read: { box.state }, abandon: {}),
            profile: profile,
            generation: model.activationGeneration - 1)

        box.state = .needsLogin
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
}
