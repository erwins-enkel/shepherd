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
        try await shutdownDuringMintAndBeforeMainActorContinuation()
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

    /// Exercise both ownership windows without time-based races or any real transport.
    private func shutdownDuringMintAndBeforeMainActorContinuation() async throws {
        for delayedStore in [false, true] {
            let host = delayedStore ? "stored-before-hop.invalid" : "inflight-mint.invalid"
            let barrier = CleanupBarrier()
            let profile = ServerProfile(name: "fixture", baseURL: URL(string: "https://\(host)")!,
                mode: .remote, credentialKey: "fixture")
            let lifecycle = IsolatedTokenLifecycle(profile: profile, sessionFactory: { configuration in
                configuration.protocolClasses = [CleanupProtocol.self]
                return URLSession(configuration: configuration)
            })
            let credentials = BarrierCredentialStore(barrier: delayedStore ? barrier : nil)
            if !delayedStore { CleanupProtocol.holdMint(host: host, barrier: barrier) }
            let resumed = Mutex(false)
            let login = Task { @MainActor in
                do {
                    try await lifecycle.login(password: "fixture", credentials: credentials, tokenName: "fixture")
                    resumed.withLock { $0 = true }
                } catch is CancellationError { }
                catch { Issue.record("Unexpected offline login failure") }
            }
            let reached = await Task.detached { barrier.waitUntilReached() }.value
            #expect(reached)
            #expect(!resumed.withLock { $0 }, "Main-actor login continuation must still be pending")
            let first = Task { await lifecycle.shutdown() }
            // The actor admission flag makes the ordering deterministic, not a sleep heuristic.
            while !(await lifecycle.isShuttingDown) { await Task.yield() }
            let second = Task { await lifecycle.shutdown() }
            #expect(CleanupProtocol.counts(host: host)["DELETE /api/access-tokens/fixture-id"] == nil)
            barrier.release.signal()
            let status = await first.value
            #expect(status.succeeded)
            #expect(await second.value == status)
            await login.value
            #expect(!resumed.withLock { $0 }, "Quit must suppress activation after the delayed mint")
            let counts = CleanupProtocol.counts(host: host)
            #expect(counts["POST /api/access-tokens"] == 1)
            #expect(counts["DELETE /api/access-tokens/fixture-id"] == 1)
            #expect(counts["GET /api/repos"] == 1)
            #expect(counts["GET /api/access-tokens"] == nil)
            #expect(CleanupProtocol.routes(host: host).suffix(2) == [
                "DELETE /api/access-tokens/fixture-id", "GET /api/repos"])
            #expect(await lifecycle.shutdown() == status)
            #expect(CleanupProtocol.counts(host: host) == counts, "Repeated shutdown must not repeat DELETE or probe")
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
        #expect(status.accessibilitySummary == "finished owned=1 verified=0 error=timeout")
        #expect(IsolatedCleanupStatus(owned: 1, verified: 1, error: nil).accessibilitySummary
            == "finished owned=1 verified=1 error=none")
        #expect(IsolatedCleanupStatus(owned: 0, verified: 0, error: .missingCredential).accessibilitySummary
            == "finished owned=0 verified=0 error=missingCredential")
        let uiEnvironment = ["SHEPHERD_ISOLATED": "1", "SHEPHERD_REVOKE_ON_EXIT": "1",
            "SHEPHERD_LIVE_BASE_URL": "https://fixture.invalid", "SHEPHERD_LIVE_PASSWORD": "fixture",
            "SHEPHERD_UI_CLEANUP_HANDSHAKE": "1"]
        #expect(LaunchEnvironment.configuration(arguments: [], environment: uiEnvironment).exposesCleanupHandshake)
        for required in uiEnvironment.keys {
            var missing = uiEnvironment
            missing.removeValue(forKey: required)
            #expect(!LaunchEnvironment.configuration(arguments: [], environment: missing).exposesCleanupHandshake)
        }
    }
}
}

private struct CleanupBarrier: Sendable {
    let reached = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    func waitUntilReached() -> Bool { reached.wait(timeout: .now() + 2) == .success }
    func wait() {
        reached.signal()
        #expect(release.wait(timeout: .now() + 5) == .success, "Offline barrier was not released")
    }
}

/// Ownership is recorded by IsolatedMintStore before this synchronous model-store save.
/// Holding it delays the login return before any main-actor continuation can execute.
private struct BarrierCredentialStore: CredentialStore {
    let barrier: CleanupBarrier?
    let memory = InMemoryCredentialStore()
    func load(for key: String) throws -> StoredCredential? { try memory.load(for: key) }
    func save(_ credential: StoredCredential, for key: String) throws {
        try memory.save(credential, for: key)
        barrier?.wait()
    }
    func delete(for key: String) throws { try memory.delete(for: key) }
}

/// Each host selects an offline response script; no shared mutable handlers or real transport.
private final class CleanupProtocol: URLProtocol {
    private static let requests = Mutex<[String: [String: Int]]>([:])
    private static let order = Mutex<[String: [String]]>([:])
    private static let barriers = Mutex<[String: CleanupBarrier]>([:])
    static func holdMint(host: String, barrier: CleanupBarrier) { barriers.withLock { $0[host] = barrier } }
    static func routes(host: String) -> [String] { order.withLock { $0[host] ?? [] } }
    static func counts(host: String) -> [String: Int] { requests.withLock { $0[host] ?? [:] } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let host = request.url!.host!
        let route = "\(request.httpMethod!) \(request.url!.path)"
        Self.requests.withLock { $0[host, default: [:]][route, default: 0] += 1 }
        Self.order.withLock { $0[host, default: []].append(route) }
        if route == "POST /api/access-tokens" {
            let barrier = Self.barriers.withLock { $0.removeValue(forKey: host) }
            barrier?.wait()
        }
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
