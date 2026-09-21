import Foundation
import ShepherdKit
import SwiftUI
import Testing
@testable import ShepherdAppCore

private actor SettingsFinalLoginLatch {
    private(set) var waiting = false
    private var continuation: CheckedContinuation<Components.Schemas.AccessTokenList, Never>?
    func read() async -> Components.Schemas.AccessTokenList {
        await withCheckedContinuation { continuation = $0; waiting = true }
    }
    func release() {
        continuation?.resume(returning: .init(tokens: []))
        continuation = nil
    }
}

extension CoreSeamTests {
@Suite(.serialized) @MainActor
struct SettingsFinalTests {
    @Test func profileSwitchDiscardsDelayedSettingsAndTokenLogin() async throws {
        let suite = "SettingsFinal-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        defer { app.teardown() }
        let settingsRead = SettingsReadLatch()
        let retired = SettingsModel(reads: .init(snapshot: { try await settingsRead.read() }))
        app.liveExtensions.append((ObjectIdentifier(SettingsModel.self), retired))
        let pendingRead = Task { await retired.load() }
        while !(await settingsRead.waiting) { await Task.yield() }

        let loginRead = SettingsFinalLoginLatch()
        let tokens = SettingsTokensModel(requests: { _ in
            .init(authenticate: { _ in await loginRead.read() },
                  mint: { _ in throw ShepherdError.notFound }, revoke: { _ in })
        })
        // Exercise the same owner teardown used by SettingsModel, with a held auth completion.
        let profile = try app.addRemoteProfile(name: "fixture", address: "http://127.0.0.1:1")
        let pendingLogin = tokens.authenticate(profile: profile, password: "fixture")
        while !(await loginRead.waiting) { await Task.yield() }
        let generation = app.activationGeneration
        app.register(SettingsModel.self)
        await app.activate(profile)
        #expect(app.activationGeneration != generation)
        let current = try #require(app.extension(SettingsModel.self))
        #expect(current !== retired)
        tokens.close() // Access pane closes on activation change and disappearance.
        await settingsRead.fail()
        await loginRead.release()
        await pendingRead.value
        await pendingLogin?.value
        #expect(retired.snapshot == nil)
        #expect(retired.error == nil)
        #expect(!tokens.authenticated)
        #expect(tokens.revealed == nil)
        #expect(tokens.entries.isEmpty)
        #expect(tokens.error == nil)
        app.teardown()
        #expect(app.extension(SettingsModel.self) == nil)
    }

    @Test func activationTeardownClearsAnAlreadyRevealedToken() async throws {
        let suite = "SettingsFinalSecret-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        defer { app.teardown() }
        let server = SettingsFakeServer()
        defer { server.tearDown() }
        server.on("POST", "/api/login") { _ in
            SettingsFakeResponse(headers: ["Content-Type": "application/json",
                "Set-Cookie": "shepherd_session=fixture; Path=/; HttpOnly"], body: Data(#"{"ok":true}"#.utf8))
        }
        server.stub("GET", "/api/access-tokens", status: 200, json: Data(#"{"tokens":[]}"#.utf8))
        server.stub("POST", "/api/access-tokens", status: 201, json: Data(#"{"token":"shp_fixture_new1","entry":{"id":"fixture","name":"fixture","hint":"cret","scope":"read","createdAt":1,"expiresAt":null,"lastUsedAt":null}}"#.utf8))
        let model = SettingsModel(reads: .init(snapshot: { throw ShepherdError.notFound }))
        app.liveExtensions.append((ObjectIdentifier(SettingsModel.self), model))
        let profile = ServerProfile(name: "fixture", baseURL: server.baseURL, mode: .local)
        await model.tokens.authenticate(profile: profile, password: "fixture", session: server.urlSession())?.value
        try #require(model.tokens.authenticated)
        await model.tokens.mint(name: "fixture", days: nil, scope: .read)?.value
        #expect(model.tokens.revealed != nil)
        app.teardown()
        #expect(model.tokens.revealed == nil)
        #expect(!model.tokens.authenticated)
        #expect(model.tokens.entries.isEmpty)
    }

}
}
