import Foundation
import Synchronization
import Testing
import ShepherdKit
@testable import ShepherdAppCore

/// The local server's identity check, as the test decides it.
private final class Verdict: Sendable {
    private let value = Mutex(false)
    private let count = Mutex(0)

    var verifications: Int { count.withLock { $0 } }
    func set(_ verified: Bool) { value.withLock { $0 = verified } }

    func verify(_: ServerProfile) -> Bool {
        count.withLock { $0 += 1 }
        return value.withLock { $0 }
    }
}

extension CoreSeamTests {
@MainActor
struct LocalCredentialGateTests {
    private let credential = StoredCredential(token: "shp_local_gate", tokenId: "gate")

    private func eventually(_ test: () -> Bool) async -> Bool {
        for _ in 0..<500 {
            if test() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return test()
    }

    /// A model whose `.local` profile is served by `server`. The client keeps
    /// the profile's credential key and the store the model hands it, so the
    /// gate under test is the one every request reads through.
    private func fixture(_ server: SettingsFakeServer) throws -> (AppModel, ServerProfile) {
        let (model, profile, _) = try fixtureWithStore(server)
        return (model, profile)
    }

    private func fixtureWithStore(
        _ server: SettingsFakeServer
    ) throws -> (AppModel, ServerProfile, InMemoryCredentialStore) {
        let suite = "LocalCredentialGate.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let credentials = InMemoryCredentialStore()
        let model = AppModel(defaults: defaults, credentials: credentials,
                             notifications: CoreTestSupport.environment(defaults: defaults))
        let profile = model.addLocalProfile()
        try credentials.save(credential, for: profile.credentialKey)
        let session = server.urlSession()
        let baseURL = server.baseURL
        model.makeClient = { profile, credentials, audit in
            let served = ServerProfile(id: profile.id, name: profile.name, baseURL: baseURL,
                                       mode: .local, credentialKey: profile.credentialKey)
            return try ShepherdClient(profile: served, credentials: credentials, urlSession: session,
                                      readOnlyAudit: audit)
        }
        model.health = { _ in throw ShepherdError.transport("fixture") }
        server.stub("GET", "/api/sessions", status: 200, json: Data("[]".utf8))
        server.stub("GET", "/api/settings", status: 200, json: try JSONEncoder().encode(ShepherdKit.Settings(
            repoRoot: "/repo", repoRootDisplay: "repo", firstRunPending: false, defaultModel: "opus",
            defaultEffort: "default", defaultAgentProvider: .claude, authMode: .subscription,
            operatorLanguage: .en)))
        server.stub("GET", "/api/repos", status: 200, json: Data(#"{"repos":[],"recentWindowDays":7}"#.utf8))
        return (model, profile, credentials)
    }

    private func firstSessionsRead(_ server: SettingsFakeServer) async -> SettingsRecordedRequest? {
        _ = await eventually { server.requests().contains { $0.path == "/api/sessions" } }
        return server.requests().first { $0.path == "/api/sessions" }
    }

    @Test func anUnverifiedLocalServerGetsNoTokenUntilItProvesItself() async throws {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let (model, profile) = try fixture(server); defer { model.teardown() }
        let verdict = Verdict()
        model.localCredentialGate = CredentialGate { verdict.verify($0) }
        model.localGateRetryInterval = .milliseconds(10)

        await model.activate(profile)

        #expect(model.store == nil)
        #expect(model.activeProfile == profile)
        #expect(model.sheet == nil)
        #expect(model.credentialAccessWarning == L.t("native_local_server_unverified"))
        // The retry keeps checking, and still nothing starts.
        #expect(await eventually { verdict.verifications >= 3 })
        #expect(model.store == nil)
        #expect(server.requests().allSatisfy { $0.headers["Authorization"] == nil })

        verdict.set(true)
        #expect(await eventually { model.store != nil })
        #expect(model.credentialAccessWarning == nil)
        let read = try #require(await firstSessionsRead(server))
        #expect(read.headers["Authorization"] == "Bearer \(credential.token)")
    }

    @Test func aVerifiedLocalServerStartsAtOnceWithTheToken() async throws {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let (model, profile) = try fixture(server); defer { model.teardown() }
        let verdict = Verdict()
        verdict.set(true)
        model.localCredentialGate = CredentialGate { verdict.verify($0) }

        await model.activate(profile)

        #expect(model.store != nil)
        #expect(model.credentialAccessWarning == nil)
        let read = try #require(await firstSessionsRead(server))
        #expect(read.headers["Authorization"] == "Bearer \(credential.token)")
    }

    @Test func withoutAGateTheLocalTokenIsSentAsBefore() async throws {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let (model, profile) = try fixture(server); defer { model.teardown() }

        await model.activate(profile)

        #expect(model.store != nil)
        #expect(model.credentialAccessWarning == nil)
        let read = try #require(await firstSessionsRead(server))
        #expect(read.headers["Authorization"] == "Bearer \(credential.token)")
    }

    /// Routes `logout` through the real `ProfileSetup.logout` against `server`.
    private func serveLogout(_ model: AppModel, _ server: SettingsFakeServer) {
        let session = server.urlSession()
        let baseURL = server.baseURL
        model.logout = { profile, credentials in
            let served = ServerProfile(id: profile.id, name: profile.name, baseURL: baseURL,
                                       mode: .local, credentialKey: profile.credentialKey)
            try await ProfileSetup.logout(profile: served, credentials: credentials, urlSession: session)
        }
        server.stub("DELETE", "/api/access-tokens/\(credential.tokenId)", status: 200, json: Data("{}".utf8))
    }

    @Test func signingOutOfAnUnverifiedLocalServerRevokesNothingAndClearsTheToken() async throws {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let (model, profile, credentials) = try fixtureWithStore(server); defer { model.teardown() }
        serveLogout(model, server)
        let verdict = Verdict()
        model.localCredentialGate = CredentialGate { verdict.verify($0) }
        model.localGateRetryInterval = .seconds(60)

        await model.activate(profile)
        #expect(model.store == nil)

        _ = await model.signOutActive()

        #expect(!server.requests().contains { $0.method == "DELETE" })
        #expect(server.requests().allSatisfy { $0.headers["Authorization"] == nil })
        #expect(try credentials.load(for: profile.credentialKey) == nil)
    }

    @Test func signingOutOfAVerifiedLocalServerRevokesWithTheToken() async throws {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let (model, profile, credentials) = try fixtureWithStore(server); defer { model.teardown() }
        serveLogout(model, server)
        let verdict = Verdict()
        verdict.set(true)
        model.localCredentialGate = CredentialGate { verdict.verify($0) }

        await model.activate(profile)
        _ = await model.signOutActive()

        let revoke = try #require(server.requests().first { $0.method == "DELETE" })
        #expect(revoke.headers["Authorization"] == "Bearer \(credential.token)")
        #expect(try credentials.load(for: profile.credentialKey) == nil)
    }

    @Test func aDroppedConnectionClosesTheGateAndAnAnonymous401AsksForNoPassword() async throws {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let (model, profile) = try fixture(server); defer { model.teardown() }
        let verdict = Verdict()
        verdict.set(true)
        let gate = CredentialGate { verdict.verify($0) }
        model.localCredentialGate = gate
        #expect(await gate.refresh(for: profile))

        let box = ConnectionBox()
        box.state = .live
        model.watchConnection(
            ConnectionSource(read: { box.state }, abandon: {}),
            profile: profile,
            generation: model.activationGeneration)

        verdict.set(false)
        box.state = .connecting
        #expect(await eventually { verdict.verifications >= 2 })
        #expect(!gate.isOpen)

        // Not a revoked token: the request that drew it went out anonymously,
        // so the profile re-activates and waits for verification instead.
        box.state = .needsLogin
        #expect(await eventually { model.credentialAccessWarning == L.t("native_local_server_unverified") })
        #expect(model.sheet == nil)
        #expect(model.store == nil)
    }
}
}
