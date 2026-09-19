import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

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

    @Test func differingVersionsShowBothNumbers() {
        let kind = BannerPolicy.kind(for: .live, lastError: nil, serverName: "Studio",
                                     serverVersion: "3.42.0", appVersion: "3.41.0")
        #expect(kind == .versionMismatch(server: "3.42.0", app: "3.41.0"))
        #expect(kind?.message.contains("3.42.0") == true)
        #expect(kind?.message.contains("3.41.0") == true)
    }

    @Test func aContractMismatchRaisesTheVersionBannerEvenWhileLive() {
        let error = ShepherdError.contractMismatch(route: "listSessions", underlying: "keyNotFound")
        #expect(BannerPolicy.kind(for: .live, lastError: error, serverName: "Studio",
                                  serverVersion: "3.42.0", appVersion: "3.41.0")
            == .versionMismatch(server: "3.42.0", app: "3.41.0"))
    }

    @Test func aContractMismatchOutranksOffline() {
        let error = ShepherdError.contractMismatch(route: "listSessions", underlying: "keyNotFound")
        #expect(BannerPolicy.kind(for: .offline(message: "lost"), lastError: error, serverName: "Studio",
                                  serverVersion: "3.42.0", appVersion: "3.41.0")
            == .versionMismatch(server: "3.42.0", app: "3.41.0"))
    }

    @Test func aContractMismatchWithoutAKnownServerVersionFallsBackToOffline() {
        let error = ShepherdError.contractMismatch(route: "listSessions", underlying: "keyNotFound")
        #expect(BannerPolicy.kind(for: .offline(message: "lost"), lastError: error, serverName: "Studio",
                                  serverVersion: nil, appVersion: "3.41.0") == .offline(server: "Studio"))
    }

    @Test func aCommandFailureIsNotABanner() {
        // A rejected create is reported inline by the sheet, not by the banner.
        #expect(BannerPolicy.kind(for: .live, lastError: .badRequest("bad input"), serverName: "Studio",
                                  serverVersion: "3.41.0", appVersion: "3.41.0") == nil)
    }

    @Test func everyKindHasCopyAndAnIcon() {
        for kind: BannerKind in [.offline(server: "S"), .versionMismatch(server: "1", app: "2"),
                                 .clientTooOld(minimum: "1", app: "2"), .needsLogin] {
            #expect(!kind.message.isEmpty)
            #expect(!kind.systemImage.isEmpty)
        }
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

    @Test func tooOldOutranksAPlainVersionDifference() {
        #expect(BannerPolicy.kind(for: .live, lastError: nil, serverName: "Studio",
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
    }

    // MARK: - Version ordering

    @Test func versionOrderingComparesNumbersNotText() {
        #expect(AppVersion.isOlder("3.9.0", than: "3.41.0"))
        #expect(!AppVersion.isOlder("3.41.0", than: "3.9.0"))
        #expect(!AppVersion.isOlder("3.41.0", than: "3.41.0"))
        #expect(AppVersion.isOlder("3.41", than: "3.41.1"))
        #expect(!AppVersion.isOlder("3.41.0", than: "3.41"))
        #expect(AppVersion.isOlder("3.41.0-rc.1", than: "3.42.0"))
    }

    @Test func versionOrderingTreatsUnparsableStringsAsNotOlder() {
        #expect(!AppVersion.isOlder("unknown", than: "3.41.0"))
        #expect(!AppVersion.isOlder("3.41.0", than: "unknown"))
        #expect(!AppVersion.isOlder("", than: "3.41.0"))
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

/// `AppModel.refreshHealth()` over a stubbed transport — the health call is the
/// only thing that ever fills `serverVersion` / `serverMinClient`, and the
/// banner is unreadable without them.
@Suite(.serialized)
@MainActor
struct AppModelHealthTests {
    private func makeModel() -> AppModel {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
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

    private func settle(until condition: () -> Bool, yields: Int = 2000) async -> Bool {
        for _ in 0..<yields {
            if condition() { return true }
            await Task.yield()
        }
        return condition()
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
                                  minClient: model.serverMinClient)
            == .offline(server: "Studio"))
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
    /// to a server they have already left.
    @Test func aHealthCompletionForASupersededStoreIsIgnored() async throws {
        let model = makeModel()
        let client = try stubClient(json(#"{"ok":true,"version":"3.42.0"}"#))
        let gate = Gate()
        model.health = { _ in
            await gate.wait()
            return try await client.health()
        }
        let profile = try model.addRemoteProfile(name: "Studio", address: "https://studio.example.ts.net")

        await model.activate(profile)
        #expect(await settle(until: { gate.isWaiting }))
        model.teardown()
        gate.open()
        _ = await settle(until: { false }, yields: 200)
        #expect(model.serverVersion == nil)
    }

    @Test func retryingWithNoActiveStoreDoesNothing() async {
        let model = makeModel()
        await model.retryActive()
        #expect(model.serverVersion == nil)
    }
}
