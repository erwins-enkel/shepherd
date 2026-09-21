import Foundation
import Synchronization
import ShepherdKit
import Testing
@testable import Shepherd

extension MacSeamTests {
@MainActor
struct IsolatedCleanupTests {
    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CleanupProtocol.self]
        return URLSession(configuration: configuration)
    }

    @Test func isolatedLiveHostCleansUpBeforeProcessExit() async throws {
        let configuration = LaunchEnvironment.configuration()
        guard configuration.isIsolated, configuration.revokesOnExit, configuration.live != nil else { return }
        let launch = try #require(IsolatedLaunch.current)
        let status = try #require(await launch.finishForTesting())
        #expect(status.succeeded, "Isolated unit host token must be 401 verified before process exit")
        if status.succeeded { print("isolated unit host: owned=1 verified=1 (401 verified)") }
    }

    @Test func requiresServer401DespiteLocalCredentialRemoval() async throws {
        let session = session()
        defer { session.invalidateAndCancel() }
        for mode in ["verified", "declined", "offline"] {
            let profile = ServerProfile(name: "fixture", baseURL: URL(string: "https://\(mode).invalid")!,
                mode: .remote, credentialKey: "fixture")
            let credentials = InMemoryCredentialStore()
            try credentials.save(.init(token: "fixture-token", tokenId: "fixture-id"), for: "fixture")
            let status = await IsolatedTokenCleanup.revoke(profile: profile, credentials: credentials, urlSession: session)
            #expect(try credentials.load(for: "fixture") == nil)
            #expect(status.succeeded == (mode == "verified"))
            #expect(status.verified == (mode == "verified" ? 1 : 0))
            if mode == "declined" { #expect(status.error == .stillAuthorized) }
            if mode == "offline" { #expect(status.error == .verificationFailed) }
        }
    }

    @Test func missingCredentialCannotProveRevocation() async {
        let session = session()
        defer { session.invalidateAndCancel() }
        let profile = ServerProfile(name: "fixture", baseURL: URL(string: "https://missing.invalid")!,
            mode: .remote, credentialKey: "fixture")
        let status = await IsolatedTokenCleanup.revoke(profile: profile,
            credentials: InMemoryCredentialStore(), urlSession: session)
        #expect(!status.succeeded)
        #expect(status.error == .missingCredential)
        #expect(CleanupProtocol.counts(host: "missing.invalid").isEmpty)
    }

    @Test func passwordFixtureMintsBeforeBodyAndCleansUpThrowingBody() async throws {
        let session = session()
        defer { session.invalidateAndCancel() }
        enum BodyFailure: Error { case expected }
        var entered = false
        do {
            try await LiveTokenFixture.withToken(address: "https://fixture.invalid/", suppliedToken: nil,
                password: "fixture-password", urlSession: session) { token in
                entered = true
                #expect(token != nil)
                let counts = CleanupProtocol.counts(host: "fixture.invalid")
                #expect(counts["POST /api/login"] == 1)
                #expect(counts["POST /api/access-tokens"] == 1)
                #expect(counts["DELETE /api/access-tokens/fixture-id"] == nil)
                throw BodyFailure.expected
            }
            Issue.record("Fixture swallowed the body failure")
        } catch BodyFailure.expected { }
        #expect(entered)
        let counts = CleanupProtocol.counts(host: "fixture.invalid")
        #expect(counts["DELETE /api/access-tokens/fixture-id"] == 1)
        #expect(counts["GET /api/repos"] == 1)
        #expect(counts["GET /api/access-tokens"] == nil, "Fixture must never sweep existing tokens")
    }

    @Test func suppliedTokenNeverAuthenticatesOrRevokesEvenOnFailure() async throws {
        let session = session()
        defer { session.invalidateAndCancel() }
        enum BodyFailure: Error { case expected }
        do {
            try await LiveTokenFixture.withToken(address: "https://supplied.invalid", suppliedToken: "caller-fixture",
                password: "unused", urlSession: session) { token in
                let unchanged = token == "caller-fixture"
                #expect(unchanged)
                throw BodyFailure.expected
            }
            Issue.record("Fixture swallowed the body failure")
        } catch BodyFailure.expected { }
        #expect(CleanupProtocol.counts(host: "supplied.invalid").isEmpty)
    }

    @Test func passwordAndProvidedTokenArmTheOriginalStaticGate() {
        #expect(LiveServerEnvironment.tokenFixtureConfigured(baseURL: "https://fixture.invalid", token: nil, password: "fixture"))
        #expect(LiveServerEnvironment.tokenFixtureConfigured(baseURL: "https://fixture.invalid", token: "fixture", password: nil))
        #expect(!LiveServerEnvironment.tokenFixtureConfigured(baseURL: nil, token: "fixture", password: "fixture"))
        #expect(!LiveServerEnvironment.tokenFixtureConfigured(baseURL: "https://fixture.invalid", token: " ", password: "\n"))
    }

    @Test func cleanupEvidenceRequiresIsolationAndRevocationOptIn() throws {
        let environment = ["SHEPHERD_CLEANUP_STATUS_PATH": "/unused/status.json"]
        #expect(LaunchEnvironment.configuration(arguments: [], environment: environment).cleanupStatusPath == nil)
        #expect(LaunchEnvironment.configuration(arguments: ["-ShepherdIsolated", "1"], environment: environment).cleanupStatusPath == nil)
        #expect(LaunchEnvironment.configuration(arguments: ["-ShepherdIsolated", "1", "-ShepherdRevokeOnExit", "1"],
            environment: environment).cleanupStatusPath != nil)
        let status = IsolatedCleanupStatus(owned: 1, verified: 0, error: .timeout)
        #expect(!status.succeeded)
        let data = try JSONEncoder().encode(status)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(object.keys) == ["owned", "verified", "error"])
        #expect(object["error"] as? String == "timeout")
    }
}
}

/// Each host selects an offline response script; no shared mutable handlers or real transport.
private final class CleanupProtocol: URLProtocol {
    private static let requests = Mutex<[String: [String: Int]]>([:])
    static func counts(host: String) -> [String: Int] { requests.withLock { $0[host] ?? [:] } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let host = request.url!.host!
        let route = "\(request.httpMethod!) \(request.url!.path)"
        Self.requests.withLock { $0[host, default: [:]][route, default: 0] += 1 }
        if host == "offline.invalid" {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        var status = 200
        var body = #"{"ok":true}"#
        var headers = ["Content-Type": "application/json"]
        switch route {
        case "POST /api/login": headers["Set-Cookie"] = "shepherd_session=fixture; Path=/; HttpOnly"
        case "POST /api/access-tokens":
            status = 201
            body = #"{"token":"fixture-token","entry":{"id":"fixture-id","name":"fixture","hint":"fixture","createdAt":1,"scope":"full"}}"#
        case "DELETE /api/access-tokens/fixture-id":
            if host == "declined.invalid" { status = 403; body = #"{"error":"forbidden"}"# }
        case "GET /api/repos":
            // Proves the probe kept the original token after logout cleared the first store.
            let retained = request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token"
            #expect(retained)
            status = host == "declined.invalid" ? 200 : 401
            body = status == 200 ? #"{"repos":[],"recentWindowDays":30}"# : #"{"error":"unauthorized"}"#
        default:
            Issue.record("Unexpected cleanup fixture request")
            status = 500
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
