import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

private actor SettingsTokenGate {
    var held = false
    var waiting = false
    var continuation: CheckedContinuation<Void, Never>?
    func hold() { held = true }
    func wait() async {
        guard held else { return }
        await withCheckedContinuation { continuation = $0; waiting = true }
    }
    func release() { held = false; continuation?.resume(); continuation = nil }
    func delay<T: Sendable>(_ operation: @Sendable () async throws -> T) async throws -> T {
        let result: Result<T, any Error>
        do { result = .success(try await operation()) } catch { result = .failure(error) }
        await wait()
        return try result.get()
    }
}
extension CoreSeamTests {
@MainActor struct SettingsTokensTests {
    private let entry = #"{"id":"minted","name":"fixture","hint":"new1","scope":"read","createdAt":1,"expiresAt":null,"lastUsedAt":null}"#
    private func fixture(_ server: SettingsFakeServer) -> ServerProfile {
        server.on("POST", "/api/login") { request in
            #expect(request.headers["Authorization"] == nil)
            return SettingsFakeResponse(headers: ["Content-Type": "application/json", "Set-Cookie": "shepherd_session=fixture; Path=/; HttpOnly"], body: Data(#"{"ok":true}"#.utf8))
        }
        server.on("GET", "/api/access-tokens") { request in
            #expect(request.headers["Authorization"] == nil)
            #expect(request.headers["Cookie"]?.contains("shepherd_session=fixture") == true)
            return SettingsFakeResponse(body: Data(#"{"tokens":[{"id":"active","name":"native","hint":"own1","scope":"full","createdAt":1,"expiresAt":null,"lastUsedAt":null}]}"#.utf8))
        }
        let entry = entry
        server.on("POST", "/api/access-tokens") { request in
            #expect(request.headers["Authorization"] == nil)
            #expect(request.headers["Cookie"]?.contains("shepherd_session=fixture") == true)
            let data = try #require(request.body)
            let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(body["name"] as? String == "fixture")
            #expect(body["scope"] as? String == "read")
            return SettingsFakeResponse(statusCode: 201, body: Data(("{\"token\":\"shp_fixture_new1\",\"entry\":" + entry + "}").utf8))
        }
        server.on("DELETE", "/api/access-tokens/minted") { request in
            #expect(request.headers["Authorization"] == nil)
            return SettingsFakeResponse(body: Data(#"{"ok":true}"#.utf8))
        }
        return .init(name: "fixture", baseURL: server.baseURL, mode: .local)
    }
    @Test func completedMintAndRevokePublishAndCloseClearsPopulatedState() async throws {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let profile = fixture(server), tokens = SettingsTokensModel(); defer { tokens.close() }
        let credentials = InMemoryCredentialStore()
        try credentials.save(.init(token: "shp_fixture_own1", tokenId: "active"), for: profile.credentialKey)
        let active = try ShepherdClient(profile: profile, credentials: credentials, urlSession: server.urlSession())
        await tokens.authenticate(profile: profile, password: "fixture", activeClient: active, session: server.urlSession())?.value
        #expect(tokens.authenticated); #expect(tokens.entries.map(\.id) == ["active"])
        await tokens.mint(name: " fixture ", days: nil, scope: .read)?.value
        #expect(tokens.revealed == "shp_fixture_new1"); #expect(tokens.entries.map(\.id) == ["minted", "active"])
        await tokens.revoke(id: "minted")?.value
        #expect(tokens.revealed == nil); #expect(tokens.entries.map(\.id) == ["active"])
        await tokens.mint(name: "fixture", days: nil, scope: .read)?.value
        #expect(tokens.revealed != nil); #expect(tokens.entries.count == 2)
        tokens.close(); tokens.close()
        assertClosed(tokens)
    }
    @Test func activeBearerCannotBeRevokedThroughCookieAdministration() async throws {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let profile = fixture(server)
        let credentials = InMemoryCredentialStore()
        try credentials.save(.init(token: "shp_fixture_own1", tokenId: "active"), for: profile.credentialKey)
        let active = try ShepherdClient(profile: profile, credentials: credentials, urlSession: server.urlSession())
        let tokens = SettingsTokensModel(); defer { tokens.close() }
        await tokens.authenticate(profile: profile, password: "fixture", activeClient: active, session: server.urlSession())?.value
        #expect(!tokens.canRevoke(id: "active"))
        let before = server.requests().count
        await tokens.revoke(id: "active")?.value
        #expect(server.requests().count == before)
        #expect(tokens.entries.map(\.id) == ["active"])
        #expect(active.currentToken() == "shp_fixture_own1")
    }
    @Test(arguments: [false, true]) func missingActiveCredentialRefusesEveryRevoke(hasClient: Bool) async throws {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let profile = fixture(server), credentials = InMemoryCredentialStore()
        let active = try ShepherdClient(profile: profile, credentials: credentials, urlSession: server.urlSession())
        let tokens = SettingsTokensModel(); defer { tokens.close() }
        await tokens.authenticate(profile: profile, password: "fixture", activeClient: hasClient ? active : nil,
                                  session: server.urlSession())?.value
        try #require(tokens.authenticated)
        try #require(tokens.entries.map(\.id) == ["active"])
        let before = server.requests().count
        #expect(!tokens.canRevoke(id: "active"))
        await tokens.revoke(id: "active")?.value
        #expect(server.requests().count == before)
        #expect(tokens.entries.map(\.id) == ["active"])
    }
    @Test(arguments: [false, true]) func lateSuccessAndFailureCannotPublishAfterClose(fails: Bool) async {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let profile = fixture(server), gate = SettingsTokenGate()
        let tokens = SettingsTokensModel(requests: { client in
            var requests = SettingsTokenRequests.live(client)
            let mint = requests.mint
            requests.mint = { body in try await gate.delay { try await mint(body) } }
            return requests
        })
        await tokens.authenticate(profile: profile, password: "fixture", session: server.urlSession())?.value
        await tokens.mint(name: "fixture", days: nil, scope: .read)?.value
        #expect(tokens.authenticated); #expect(tokens.entries.count == 2); #expect(tokens.revealed != nil)
        if fails {
            server.on("POST", "/api/access-tokens") { _ in SettingsFakeResponse(statusCode: 403, body: Data(#"{"error":"forbidden"}"#.utf8)) }
        }
        await gate.hold()
        let pending = tokens.mint(name: "fixture", days: nil, scope: .read)
        let deadline = ContinuousClock.now + .seconds(5)
        while !(await gate.waiting), ContinuousClock.now < deadline { await Task.yield() }
        #expect(await gate.waiting)
        #expect(tokens.busy)
        tokens.close(); assertClosed(tokens)
        await gate.release(); await pending?.value
        assertClosed(tokens)
    }
    @Test func failedMintPublishesErrorBeforeClosure() async {
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let profile = fixture(server), tokens = SettingsTokensModel(); defer { tokens.close() }
        await tokens.authenticate(profile: profile, password: "fixture", session: server.urlSession())?.value
        server.on("POST", "/api/access-tokens") { _ in
            SettingsFakeResponse(statusCode: 403, body: Data(#"{"error":"forbidden"}"#.utf8))
        }
        await tokens.mint(name: "fixture", days: nil, scope: .read)?.value
        #expect(tokens.error != nil); #expect(!tokens.busy)
        #expect(tokens.authenticated); #expect(tokens.entries.map(\.id) == ["active"])
        tokens.close(); assertClosed(tokens)
    }
    @Test func nameValidationUsesTrimmedUTF16AndRefusesInvalidRequests() async {
        #expect(SettingsTokensModel.normalizedName(String(repeating: "😀", count: 32)) != nil)
        #expect(SettingsTokensModel.normalizedName(String(repeating: "😀", count: 33)) == nil)
        #expect(SettingsTokensModel.normalizedName("  " + String(repeating: "a", count: 64) + "  ")?.utf16.count == 64)
        #expect(SettingsTokensModel.normalizedName(" \n ") == nil)
        #expect(SettingsTokensModel.normalizedName("\u{FEFF}fixture\u{FEFF}") == "fixture")
        #expect(SettingsTokensModel.normalizedName("\u{0085}") == "\u{0085}")
        let server = SettingsFakeServer(); defer { server.tearDown() }
        let profile = fixture(server), tokens = SettingsTokensModel(); defer { tokens.close() }
        await tokens.authenticate(profile: profile, password: "fixture", session: server.urlSession())?.value
        let before = server.requests().count
        await tokens.mint(name: String(repeating: "😀", count: 33), days: nil, scope: .read)?.value
        #expect(server.requests().count == before)
    }
    private func assertClosed(_ tokens: SettingsTokensModel, sourceLocation: SourceLocation = #_sourceLocation) {
        #expect(tokens.revealed == nil, sourceLocation: sourceLocation)
        #expect(tokens.entries.isEmpty, sourceLocation: sourceLocation)
        #expect(!tokens.authenticated, sourceLocation: sourceLocation)
        #expect(!tokens.busy, sourceLocation: sourceLocation)
        #expect(tokens.error == nil, sourceLocation: sourceLocation)
    }
}
}
