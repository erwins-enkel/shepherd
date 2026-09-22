import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

extension CoreSeamTests {
@MainActor
struct ConnectionBannerTests {
    @Test func idleAndConnectingShowNothing() {
        #expect(BannerPolicy.kind(for: .idle, lastError: nil, serverName: "Studio",
                                  serverVersion: nil, appVersion: "3.41.0") == nil)
        #expect(BannerPolicy.kind(for: .connecting, lastError: nil, serverName: "Studio",
                                  serverVersion: nil, appVersion: "3.41.0") == nil)
    }

    @Test func liveWithMatchingVersionsShowsNothing() {
        #expect(BannerPolicy.kind(for: .live, lastError: nil, serverName: "Studio",
                                  serverVersion: "3.41.0", appVersion: "3.41.0") == nil)
    }

    @Test func firstRunPendingShowsNothingBecauseASheetHandlesIt() {
        #expect(BannerPolicy.kind(for: .firstRunPending, lastError: nil, serverName: "Studio",
                                  serverVersion: "3.41.0", appVersion: "3.41.0") == nil)
    }

    @Test func offlineNamesTheServer() {
        let kind = BannerPolicy.kind(for: .offline(message: "timed out"), lastError: .transport("timed out"),
                                     serverName: "Studio", serverVersion: nil, appVersion: "3.41.0")
        #expect(kind == .offline(server: "Studio"))
        #expect(kind?.message.contains("Studio") == true)
    }

    @Test func needsLoginHasItsOwnBanner() {
        #expect(BannerPolicy.kind(for: .needsLogin, lastError: .unauthenticated, serverName: "Studio",
                                  serverVersion: "3.41.0", appVersion: "3.41.0") == .needsLogin)
    }

    /// The app's `MARKETING_VERSION` and the server's `package.json` version are
    /// different version lines — they differ on *every* healthy connection — so a
    /// plain inequality would be a banner that never goes away.
    @Test func differingVersionsAloneAreNotABanner() {
        #expect(BannerPolicy.kind(for: .live, lastError: nil, serverName: "Studio",
                                  serverVersion: "1.47.0", appVersion: "0.1.0") == nil)
        #expect(BannerPolicy.kind(for: .live, lastError: .badRequest("nope"), serverName: "Studio",
                                  serverVersion: "1.47.0", appVersion: "0.1.0") == nil)
    }

    @Test func aContractMismatchRaisesItsOwnBannerEvenWhileLive() {
        let error = ShepherdError.contractMismatch(route: "listSessions", underlying: "keyNotFound")
        let kind = BannerPolicy.kind(for: .live, lastError: error, serverName: "Studio",
                                     serverVersion: "1.47.0", appVersion: "0.1.0")
        #expect(kind == .contractMismatch(server: "1.47.0", app: "0.1.0"))
        #expect(kind?.message.contains("1.47.0") == true)
        #expect(kind?.message.contains("0.1.0") == true)
    }

    @Test func aContractMismatchOutranksOffline() {
        let error = ShepherdError.contractMismatch(route: "listSessions", underlying: "keyNotFound")
        #expect(BannerPolicy.kind(for: .offline(message: "lost"), lastError: error, serverName: "Studio",
                                  serverVersion: "1.47.0", appVersion: "0.1.0")
            == .contractMismatch(server: "1.47.0", app: "0.1.0"))
    }

    @Test func aContractMismatchWithoutAKnownServerVersionFallsBackToOffline() {
        let error = ShepherdError.contractMismatch(route: "listSessions", underlying: "keyNotFound")
        #expect(BannerPolicy.kind(for: .offline(message: "lost"), lastError: error, serverName: "Studio",
                                  serverVersion: nil, appVersion: "3.41.0") == .offline(server: "Studio"))
    }

    /// Z4a: the same case while the socket still reads `.live` — the mismatch
    /// was itself the health payload that would have named the server, so
    /// `serverVersion` never landed. Silence is wrong for a socket that cannot
    /// be trusted, but so is `.offline`'s "cannot reach this server": this is
    /// the *common* mismatch path, and the app has just heard from the server.
    /// `.unhealthy` is what "answered, but something is wrong with it" reads
    /// as (B3, whole-branch wave).
    @Test func aContractMismatchWhileLiveWithoutAKnownServerVersionReadsAsUnhealthy() {
        let error = ShepherdError.contractMismatch(route: "listSessions", underlying: "keyNotFound")
        let kind = BannerPolicy.kind(for: .live, lastError: error, serverName: "Studio",
                                     serverVersion: nil, appVersion: "3.41.0")
        #expect(kind == .unhealthy(server: "Studio"))
        #expect(kind?.message != BannerKind.offline(server: "Studio").message)
    }

    /// The socket being genuinely down keeps `.offline`: there the app really
    /// cannot reach the server.
    @Test func aContractMismatchWhileOfflineWithoutAKnownServerVersionStaysOffline() {
        let error = ShepherdError.contractMismatch(route: "listSessions", underlying: "keyNotFound")
        #expect(BannerPolicy.kind(for: .offline(message: "lost"), lastError: error,
                                  serverName: "Studio", serverVersion: nil,
                                  appVersion: "3.41.0") == .offline(server: "Studio"))
    }

    @Test func aCommandFailureIsNotABanner() {
        // A rejected create is reported inline by the sheet, not by the banner.
        #expect(BannerPolicy.kind(for: .live, lastError: .badRequest("bad input"), serverName: "Studio",
                                  serverVersion: "3.41.0", appVersion: "3.41.0") == nil)
    }

    @Test func everyKindHasCopyAndAnIcon() {
        for kind: BannerKind in [.offline(server: "S"), .contractMismatch(server: "1", app: "2"),
                                 .clientTooOld(minimum: "1", app: "2"), .unhealthy(server: "S"),
                                 .needsLogin] {
            #expect(!kind.message.isEmpty)
            #expect(!kind.systemImage.isEmpty)
        }
    }

    // MARK: - An unhealthy server

    /// `GET /api/health` answering `ok: false` is a server saying it is not well.
    /// The socket may still read `.live`, so without this the window would show
    /// nothing at all.
    @Test func aServerThatReportsNotOkShowsItsOwnBanner() {
        #expect(BannerPolicy.kind(for: .live, lastError: nil, serverName: "Studio",
                                  serverVersion: nil, appVersion: "3.41.0",
                                  serverUnhealthy: true) == .unhealthy(server: "Studio"))
    }

    /// Z4b: `.unhealthy` carries its own copy — "answered but reports a
    /// problem" — rather than `.offline`'s "cannot reach", which is the wrong
    /// sentence for a server that just answered.
    @Test func anUnhealthyBannerNamesTheServerWithItsOwnCopy() {
        let kind = BannerKind.unhealthy(server: "Studio")
        #expect(kind.message.contains("Studio"))
        #expect(kind.message != BannerKind.offline(server: "Studio").message)
    }

    @Test func anUnhealthyServerStillYieldsToNeedsLogin() {
        #expect(BannerPolicy.kind(for: .needsLogin, lastError: .unauthenticated, serverName: "Studio",
                                  serverVersion: nil, appVersion: "3.41.0",
                                  serverUnhealthy: true) == .needsLogin)
    }

    // MARK: - minClient

    @Test func aMinimumClientNewerThanTheAppIsItsOwnBanner() {
        let kind = BannerPolicy.kind(for: .live, lastError: nil, serverName: "Studio",
                                     serverVersion: "3.43.0", appVersion: "3.41.0",
                                     minClient: "3.42.0")
        #expect(kind == .clientTooOld(minimum: "3.42.0", app: "3.41.0"))
        #expect(kind?.message.contains("3.42.0") == true)
        #expect(kind?.message.contains("3.41.0") == true)
    }

    /// The server can declare a minimum newer than the *app* while the two
    /// version strings are identical — a plain inequality check would show
    /// nothing at all here.
    @Test func aMinimumClientNewerThanTheAppShowsEvenWhenTheVersionsMatch() {
        #expect(BannerPolicy.kind(for: .live, lastError: nil, serverName: "Studio",
                                  serverVersion: "3.41.0", appVersion: "3.41.0",
                                  minClient: "3.42.0")
            == .clientTooOld(minimum: "3.42.0", app: "3.41.0"))
    }

    @Test func aMinimumClientTheAppAlreadyMeetsSaysNothing() {
        #expect(BannerPolicy.kind(for: .live, lastError: nil, serverName: "Studio",
                                  serverVersion: "3.41.0", appVersion: "3.41.0",
                                  minClient: "3.40.0") == nil)
        #expect(BannerPolicy.kind(for: .live, lastError: nil, serverName: "Studio",
                                  serverVersion: "3.41.0", appVersion: "3.41.0",
                                  minClient: "3.41.0") == nil)
    }

    /// A release candidate sitting *on* the minimum is still below it under
    /// SemVer precedence, and the operator has to know before the server starts
    /// refusing them.
    @Test func aPrereleaseBuildOfTheMinimumIsStillTooOld() {
        #expect(BannerPolicy.kind(for: .live, lastError: nil, serverName: "Studio",
                                  serverVersion: "3.42.0", appVersion: "3.42.0-rc.1",
                                  minClient: "3.42.0")
            == .clientTooOld(minimum: "3.42.0", app: "3.42.0-rc.1"))
    }

    @Test func tooOldOutranksAContractMismatch() {
        let error = ShepherdError.contractMismatch(route: "listSessions", underlying: "keyNotFound")
        #expect(BannerPolicy.kind(for: .live, lastError: error, serverName: "Studio",
                                  serverVersion: "4.0.0", appVersion: "3.41.0",
                                  minClient: "4.0.0")
            == .clientTooOld(minimum: "4.0.0", app: "3.41.0"))
    }

    @Test func tooOldOutranksOfflineWhenTheConnectionAlsoDropped() {
        let error = ShepherdError.contractMismatch(route: "listSessions", underlying: "keyNotFound")
        #expect(BannerPolicy.kind(for: .offline(message: "lost"), lastError: error,
                                  serverName: "Studio", serverVersion: "4.0.0",
                                  appVersion: "3.41.0", minClient: "4.0.0")
            == .clientTooOld(minimum: "4.0.0", app: "3.41.0"))
    }

    @Test func anUnparsableMinimumIsIgnoredRatherThanGuessed() {
        #expect(BannerPolicy.kind(for: .live, lastError: nil, serverName: "Studio",
                                  serverVersion: "3.41.0", appVersion: "3.41.0",
                                  minClient: "next") == nil)
        #expect(BannerPolicy.kind(for: .live, lastError: nil, serverName: "Studio",
                                  serverVersion: "3.41.0", appVersion: "3.41.0",
                                  minClient: "4.0.0-") == nil)
    }

    @Test func anUnparsableAppVersionIsIgnoredRatherThanGuessed() {
        #expect(BannerPolicy.kind(for: .live, lastError: nil, serverName: "Studio",
                                  serverVersion: "3.41.0", appVersion: "dev",
                                  minClient: "4.0.0") == nil)
    }

    // MARK: - SemVer precedence

    @Test func versionOrderingComparesNumbersNotText() {
        #expect(AppVersion.isOlder("3.9.0", than: "3.41.0") == true)
        #expect(AppVersion.isOlder("3.41.0", than: "3.9.0") == false)
        #expect(AppVersion.isOlder("3.41.0", than: "3.41.0") == false)
        #expect(AppVersion.isOlder("3.41.0", than: "3.41.1") == true)
        #expect(AppVersion.isOlder("3.41.1", than: "3.41.0") == false)
        #expect(AppVersion.isOlder("3.41.0-rc.1", than: "3.42.0") == true)
    }

    /// SemVer 2.0 §11: a version *with* a prerelease has lower precedence than
    /// the same core without one, and identifiers compare dot by dot.
    @Test func prereleasesRankBelowTheirRelease() {
        #expect(AppVersion.isOlder("3.42.0-rc.1", than: "3.42.0") == true)
        #expect(AppVersion.isOlder("3.42.0", than: "3.42.0-rc.1") == false)
        #expect(AppVersion.isOlder("3.42.0-rc.1", than: "3.42.0-rc.2") == true)
    }

    @Test func prereleaseIdentifiersFollowSemverPrecedence() {
        let ascending = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
                         "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"]
        for (index, lower) in ascending.enumerated() {
            for higher in ascending[(index + 1)...] {
                #expect(AppVersion.isOlder(lower, than: higher) == true,
                        "\(lower) should rank below \(higher)")
                #expect(AppVersion.isOlder(higher, than: lower) == false,
                        "\(higher) should not rank below \(lower)")
            }
        }
    }

    @Test func buildMetadataIsIgnored() {
        #expect(AppVersion.isOlder("1.0.0+build.5", than: "1.0.0") == false)
        #expect(AppVersion.isOlder("1.0.0", than: "1.0.0+build.5") == false)
        #expect(AppVersion.isOlder("1.0.0-rc.1+build.5", than: "1.0.0+build.1") == true)
    }

    /// "Unknown", not "equal": a version this build cannot read must never be
    /// the reason a banner appears or stays away by accident.
    @Test func malformedVersionsAreUnknown() {
        #expect(AppVersion.isOlder("unknown", than: "3.41.0") == nil)
        #expect(AppVersion.isOlder("3.41.0", than: "unknown") == nil)
        #expect(AppVersion.isOlder("", than: "3.41.0") == nil)
        #expect(AppVersion.isOlder("4.0.0-", than: "4.0.0") == nil)
        #expect(AppVersion.isOlder("4.0.0-rc..1", than: "4.0.0") == nil)
        #expect(AppVersion.isOlder("1.0.x", than: "1.0.1") == nil)
        #expect(AppVersion.isOlder("1.0.0.1", than: "1.0.1") == nil)
        #expect(AppVersion.isOlder("1.0.0+", than: "1.0.1") == nil)
    }

    /// Z1: SemVer 2.0's grammar in full, one assertion per rule the old parser
    /// let through. `01.0.0` and `1.0.0-01` are leading-zero numeric
    /// identifiers (core and prerelease respectively) — both forbidden
    /// outright, not a licence to read them as text. `1.0` is a core shorter
    /// than three components; `1.0.0.1` one longer. `v1.0.0` is not a version
    /// at all. `1.0.0-` is a prerelease marker with nothing after it. The
    /// empty string is not a version. None of these may compare as older,
    /// newer or equal — only `nil`, so a caller never turns an unreadable
    /// version into a banner (or, worse, into silence) by accident.
    @Test func strictSemVerRejectsEveryNonCompliantForm() {
        for malformed in ["01.0.0", "1.0.0-01", "1.0", "1.0.0.1", "v1.0.0", "1.0.0-", ""] {
            #expect(AppVersion.isOlder(malformed, than: "1.0.0") == nil, "\(malformed) should be unknown")
            #expect(AppVersion.isOlder("1.0.0", than: malformed) == nil, "\(malformed) should be unknown")
        }
        // A minimum this strict is exactly what makes `02.0.0` refuse to raise
        // a too-old banner for the release `2.0.0` — the version pair the
        // fix report's finding used.
        #expect(BannerPolicy.kind(for: .live, lastError: nil, serverName: "Studio",
                                  serverVersion: "2.0.0", appVersion: "1.0.0",
                                  minClient: "02.0.0") == nil)
    }
}
}

/// URLProtocol stub for the health round-trip. Deliberately a *second* stub
/// class rather than `LocalServerProbeTests`' `StubProtocol`: both keep their
/// handler in a static, and two suites sharing one static would race whenever
/// Swift Testing runs them in parallel.
final class HealthStubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

/// One mutable value a stubbed health closure can read or bump. `Gate`'s
/// sibling: the closure is `@MainActor`, so no synchronisation is needed.
@MainActor
final class Box<Value> {
    var value: Value
    init(_ value: Value) { self.value = value }
}

extension CoreSeamTests {
/// `AppModel`'s health task over a stubbed round-trip — the health call is the
/// only thing that ever fills `serverVersion` / `serverMinClient`, and the
/// banner is unreadable without them.
@Suite(.serialized)
@MainActor
struct AppModelHealthTests {
    private func makeModel() -> AppModel {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
    }

    /// A real `ShepherdClient` whose transport answers with `handler`.
    private func stubClient(
        _ handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
    ) throws -> ShepherdClient {
        HealthStubProtocol.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HealthStubProtocol.self]
        let profile = ServerProfile(
            name: "Studio", baseURL: URL(string: "https://studio.example.ts.net")!, mode: .remote)
        return try ShepherdClient(
            profile: profile,
            credentials: InMemoryCredentialStore(),
            urlSession: URLSession(configuration: config))
    }

    private func json(_ body: String) -> @Sendable (URLRequest) throws -> (HTTPURLResponse, Data) {
        { request in
            (HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!,
             Data(body.utf8))
        }
    }

    /// Polls until `condition` holds or `timeout` expires, and reports whether
    /// it held. The yield is for the main-actor work under test; the
    /// millisecond sleep is for the tests that also wait on real I/O — a
    /// refused loopback connection, which yields alone never let finish.
    private func settle(until condition: () -> Bool,
                        timeout: Duration = .seconds(5)) async -> Bool {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if condition() { return true }
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(1))
        }
        return condition()
    }

    /// Gives a completion that must *not* land its chance to land anyway.
    private func letStaleWorkLand() async {
        _ = await settle(until: { false }, timeout: .milliseconds(50))
    }

    @Test func healthRecordsTheServerVersionAndItsMinimumClient() async throws {
        let model = makeModel()
        let client = try stubClient(json(#"{"ok":true,"version":"3.42.0","minClient":"3.43.0"}"#))
        model.health = { _ in try await client.health() }
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")

        await model.activate(profile)
        #expect(await settle(until: { model.serverVersion != nil }))
        #expect(model.serverVersion == "3.42.0")
        #expect(model.serverMinClient == "3.43.0")
        #expect(!model.serverUnhealthy)
    }

    @Test func aServerWithoutAMinimumClientRecordsOnlyItsVersion() async throws {
        let model = makeModel()
        let client = try stubClient(json(#"{"ok":true,"version":"3.42.0"}"#))
        model.health = { _ in try await client.health() }
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")

        await model.activate(profile)
        #expect(await settle(until: { model.serverVersion != nil }))
        #expect(model.serverMinClient == nil)
    }

    /// The contract types `ok` as a plain boolean, not `const: true`, so
    /// `{"ok":false}` decodes cleanly and the *app* has to decide what it means.
    ///
    /// Z4b: the banner it decides on is `.unhealthy`, not `.offline` — the
    /// server just answered, so "cannot reach" would be the wrong sentence.
    @Test func aServerReportingNotOkRecordsNoVersionAndShowsTheUnhealthyBanner() async throws {
        let model = makeModel()
        let client = try stubClient(json(#"{"ok":false,"version":"3.42.0","minClient":"3.99.0"}"#))
        model.health = { _ in try await client.health() }
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")

        await model.activate(profile)
        #expect(await settle(until: { model.serverUnhealthy }))
        #expect(model.serverVersion == nil)
        #expect(model.serverMinClient == nil)
        #expect(BannerPolicy.kind(for: .live, lastError: nil, serverName: profile.name,
                                  serverVersion: model.serverVersion, appVersion: model.appVersion,
                                  minClient: model.serverMinClient,
                                  serverUnhealthy: model.serverUnhealthy)
            == .unhealthy(server: "Studio"))
    }

    /// The deferred Gate-1 case: a health call that never answers must leave the
    /// version unknown — and an unknown version is exactly what makes the
    /// offline banner (rather than a version banner) the right thing to show.
    @Test func aHealthCallThatTimesOutLeavesTheVersionUnknown() async throws {
        let model = makeModel()
        let client = try stubClient { _ in throw URLError(.timedOut) }
        model.health = { _ in try await client.health() }
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")

        await model.activate(profile)
        await model.refreshHealth()
        #expect(model.serverVersion == nil)
        #expect(model.serverMinClient == nil)
        #expect(BannerPolicy.kind(for: .offline(message: "timed out"),
                                  lastError: .transport("timed out"),
                                  serverName: profile.name,
                                  serverVersion: model.serverVersion,
                                  appVersion: model.appVersion,
                                  minClient: model.serverMinClient,
                                  serverUnhealthy: model.serverUnhealthy)
            == .offline(server: "Studio"))
    }

    /// "Unknown on failure" means *forgetting*, not keeping: a version the
    /// banner still compares against is a claim about a server the app can no
    /// longer reach.
    @Test func aFailedHealthRefreshForgetsTheVersionsItHad() async throws {
        let model = makeModel()
        let failing = Box(false)
        model.health = { _ in
            if failing.value { throw ShepherdError.transport("down") }
            return Health(ok: true, version: "3.42.0", minClient: "3.40.0")
        }
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")

        await model.activate(profile)
        #expect(await settle(until: { model.serverVersion != nil }))
        failing.value = true
        await model.refreshHealth()
        #expect(model.serverVersion == nil)
        #expect(model.serverMinClient == nil)
    }

    @Test func tearingDownForgetsTheServerVersion() async throws {
        let model = makeModel()
        let client = try stubClient(json(#"{"ok":true,"version":"3.42.0","minClient":"3.43.0"}"#))
        model.health = { _ in try await client.health() }
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")

        await model.activate(profile)
        #expect(await settle(until: { model.serverVersion != nil }))
        model.teardown()
        #expect(model.serverVersion == nil)
        #expect(model.serverMinClient == nil)
    }

    /// A health call the operator outran must not write a version that belongs
    /// to a server they have already left. The gate is released *after* the
    /// switch, so the stale answer really does arrive last.
    @Test func aHealthCompletionForASupersededStoreIsIgnored() async throws {
        let model = makeModel()
        let gate = Gate()
        model.health = { client in
            guard client.profile.name == "Studio" else { return Health(ok: true, version: "2.0.0") }
            await gate.wait()
            return Health(ok: true, version: "1.0.0")
        }
        let studio = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")
        let loft = try model.addRemoteProfile(name: "Loft", address: "https://loft.example.ts.net")

        await model.activate(studio)
        #expect(await settle(until: { gate.isWaiting }))
        await model.activate(loft)
        #expect(await settle(until: { model.serverVersion == "2.0.0" }))

        gate.open()
        await letStaleWorkLand()
        #expect(model.serverVersion == "2.0.0")
    }

    /// A teardown does not bump the request generation — it takes the *store*
    /// away — so this is the identity guard's own case: an answer gated open
    /// after the operator left must write nothing at all.
    @Test func aHealthCompletionThatOutlivesATeardownWritesNothing() async throws {
        let model = makeModel()
        let gate = Gate()
        model.health = { _ in
            await gate.wait()
            return Health(ok: true, version: "3.42.0", minClient: "3.43.0")
        }
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")

        await model.activate(profile)
        #expect(await settle(until: { gate.isWaiting }))
        model.teardown()
        gate.open()
        await letStaleWorkLand()
        #expect(model.serverVersion == nil)
        #expect(model.serverMinClient == nil)
        #expect(!model.serverUnhealthy)
    }

    /// Two health calls against the *same* store — a Retry during activation's
    /// own request. The first answer lands last and must not win.
    @Test func anOlderHealthRequestDoesNotOverwriteANewerOne() async throws {
        let model = makeModel()
        let gate = Gate()
        let calls = Box(0)
        model.health = { _ in
            calls.value += 1
            guard calls.value == 1 else { return Health(ok: true, version: "2.0.0") }
            await gate.wait()
            return Health(ok: true, version: "1.0.0")
        }
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")

        await model.activate(profile)
        #expect(await settle(until: { gate.isWaiting }))
        await model.refreshHealth()
        #expect(model.serverVersion == "2.0.0")

        gate.open()
        await letStaleWorkLand()
        #expect(model.serverVersion == "2.0.0")
    }

    @Test func retryRefreshesTheServerVersion() async throws {
        let model = makeModel()
        let version = Box("3.42.0")
        model.health = { _ in Health(ok: true, version: version.value) }
        // Loopback with nothing listening: `SessionStore.refresh()` fails fast
        // instead of waiting out a DNS lookup.
        let profile = try model.addRemoteProfile(name: "Studio", address: "http://127.0.0.1:9")

        await model.activate(profile)
        #expect(await settle(until: { model.serverVersion == "3.42.0" }))
        version.value = "3.43.0"
        await model.retryActive()
        #expect(model.serverVersion == "3.43.0")
        #expect(!model.retrying)
    }

    /// A double-clicked Retry must make one round trip, not two. Only the
    /// first retry's health call parks on the gate — a second one answers at
    /// once, so a retry that should have been refused shows up as a third call
    /// rather than as a deadlock.
    @Test func retryIgnoresASecondClickWhileTheFirstIsRunning() async throws {
        let model = makeModel()
        model.refreshStore = { _ in }
        let gate = Gate()
        let calls = Box(0)
        model.health = { _ in
            calls.value += 1
            if calls.value == 2 { await gate.wait() }
            return Health(ok: true, version: "3.42.0")
        }
        // Loopback avoids an external bootstrap target; the stubbed retry
        // refresh lets this health gate control the scenario's progress.
        let profile = try model.addRemoteProfile(name: "Studio", address: "http://127.0.0.1:9")

        await model.activate(profile)
        #expect(await settle(until: { model.serverVersion == "3.42.0" }))

        model.retry()
        #expect(await settle(until: { gate.isWaiting }))
        #expect(model.retrying)

        // The second click, awaited: it must return without starting anything.
        model.retry()
        await model.retryActive()
        #expect(calls.value == 2)

        gate.open()
        #expect(await settle(until: { !model.retrying }))
        #expect(calls.value == 2)
    }

    /// Z2b: `retry()` used to check `retrying` but only set it inside the
    /// task body, so two clicks in the same run-loop turn both passed the
    /// guard before either task ran — `retryTask` ended up pointing at the
    /// second (a no-op) while the first ran untracked. `retrying` must now be
    /// true the instant both synchronous calls return, before either task has
    /// had a chance to run, and only one health request must ever be made.
    @Test func twoSynchronousRetryCallsMakeOnlyOneHealthRequest() async throws {
        let model = makeModel()
        model.refreshStore = { _ in }
        let gate = Gate()
        let calls = Box(0)
        model.health = { _ in
            calls.value += 1
            if calls.value == 2 { await gate.wait() }
            return Health(ok: true, version: "3.42.0")
        }
        // Loopback avoids an external bootstrap target; the stubbed retry
        // refresh lets this health gate control the scenario's progress.
        let profile = try model.addRemoteProfile(name: "Studio", address: "http://127.0.0.1:9")

        await model.activate(profile)
        #expect(await settle(until: { model.serverVersion == "3.42.0" }))

        model.retry()
        model.retry()
        #expect(model.retrying)

        #expect(await settle(until: { gate.isWaiting }))
        #expect(model.retrying)

        gate.open()
        #expect(await settle(until: { !model.retrying }))
        #expect(calls.value == 2)
    }

    /// Z2: a cancelled Retry must not clear a *newer* activation's `retrying`
    /// flag. Retry A (Studio) parks on health; switching to Loft cancels A's
    /// task and resets `retrying` for the activation being left; Retry B
    /// (Loft) then starts. A's task is not structurally cancelled by that —
    /// only marked — so it keeps running and, once unblocked, still runs its
    /// deferred cleanup. That cleanup must skip resetting `retrying` because
    /// its own generation (Studio's) no longer matches the current one,
    /// or it would clear the flag B is relying on while B is still in flight.
    @Test func aCancelledRetryDoesNotClearANewerActivationsRetryingFlag() async throws {
        let model = makeModel()
        model.refreshStore = { _ in }
        let gateA = Gate()
        let gateB = Gate()
        let studioCalls = Box(0)
        let loftCalls = Box(0)
        model.health = { client in
            if client.profile.name == "Studio" {
                studioCalls.value += 1
                guard studioCalls.value == 2 else { return Health(ok: true, version: "1.0.0") }
                await gateA.wait()
                return Health(ok: true, version: "1.0.0")
            }
            loftCalls.value += 1
            guard loftCalls.value == 2 else { return Health(ok: true, version: "2.0.0") }
            await gateB.wait()
            return Health(ok: true, version: "2.1.0")
        }
        let studio = try model.addRemoteProfile(name: "Studio", address: "http://127.0.0.1:9")
        // A *different* address: `addRemoteProfile` reuses the saved row for an
        // address that is already stored (B8), and this test needs two profiles.
        // Both ports are closed to keep activation's background bootstrap local;
        // the health closure and retry refresh are already stubbed for this scenario.
        let loft = try model.addRemoteProfile(name: "Loft", address: "http://127.0.0.1:10")

        await model.activate(studio)
        guard await settle(until: { model.serverVersion == "1.0.0" }) else { throw URLError(.timedOut) }
        model.retry()
        #expect(await settle(until: { gateA.isWaiting }))
        #expect(model.retrying)

        await model.activate(loft)
        #expect(await settle(until: { model.serverVersion == "2.0.0" }))
        #expect(!model.retrying)

        model.retry()
        #expect(await settle(until: { gateB.isWaiting }))
        #expect(model.retrying)

        // Unblock Studio's stale Retry. Its deferred cleanup must see that
        // `activationGeneration` has moved on and leave `retrying` alone.
        gateA.open()
        await letStaleWorkLand()
        #expect(model.retrying)

        gateB.open()
        #expect(await settle(until: { !model.retrying }))
        #expect(model.serverVersion == "2.1.0")
    }

    @Test func retryingWithNoActiveStoreDoesNothing() async {
        let model = makeModel()
        await model.retryActive()
        #expect(model.serverVersion == nil)
        #expect(!model.retrying)
    }

    /// Z3 (Y3 lifecycle coverage): a teardown during a Retry-triggered health
    /// refresh cancels the model-owned health task — not just the retry's
    /// own — and a result the stub returns anyway is dropped rather than
    /// resurrecting state for a profile the operator has already left.
    @Test func teardownDuringARetryTriggeredHealthRefreshCancelsTheModelOwnedTask() async throws {
        let model = makeModel()
        let gate = Gate()
        let calls = Box(0)
        let observedCancellation = Box(false)
        model.health = { _ in
            calls.value += 1
            guard calls.value == 2 else { return Health(ok: true, version: "3.42.0") }
            await gate.wait()
            observedCancellation.value = Task.isCancelled
            return Health(ok: true, version: "9.9.9")
        }
        let profile = try model.addRemoteProfile(name: "Studio", address: "http://127.0.0.1:9")

        await model.activate(profile)
        #expect(await settle(until: { model.serverVersion != nil }))

        model.retry()
        #expect(await settle(until: { gate.isWaiting }))
        #expect(model.retrying)

        model.teardown()
        #expect(!model.retrying)

        gate.open()
        await letStaleWorkLand()
        #expect(observedCancellation.value)
        #expect(model.serverVersion == nil)
        #expect(model.serverMinClient == nil)
    }

    /// `deactivate()` is `teardown()`'s non-revoking twin and shares the same
    /// cancellation path — the health task started by a Retry must not
    /// outlive it either.
    @Test func deactivateDuringARetryTriggeredHealthRefreshCancelsTheModelOwnedTask() async throws {
        let model = makeModel()
        let gate = Gate()
        let calls = Box(0)
        let observedCancellation = Box(false)
        model.health = { _ in
            calls.value += 1
            guard calls.value == 2 else { return Health(ok: true, version: "3.42.0") }
            await gate.wait()
            observedCancellation.value = Task.isCancelled
            return Health(ok: true, version: "9.9.9")
        }
        let profile = try model.addRemoteProfile(name: "Studio", address: "http://127.0.0.1:9")

        await model.activate(profile)
        #expect(await settle(until: { model.serverVersion != nil }))

        model.retry()
        #expect(await settle(until: { gate.isWaiting }))
        #expect(model.retrying)

        model.deactivate()
        #expect(!model.retrying)

        gate.open()
        await letStaleWorkLand()
        #expect(observedCancellation.value)
        #expect(model.serverVersion == nil)
        #expect(model.serverMinClient == nil)
    }
}
}
