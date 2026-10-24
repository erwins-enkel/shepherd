import XCTest
import ShepherdAppCore
import ShepherdKit
@testable import ShepherdIOS

@MainActor
final class IOSCompositionTests: XCTestCase {
    func testBootstrapDoesNotRequestBlockedOffscreenLists() async throws {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel()
        app.makeClient = { profile, credentials, audit in
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [IOSMultiServerFixtureTransport.self]
            return try ShepherdClient(profile: profile, credentials: credentials, readOnlyAudit: audit,
                requestAttempts: 1, readURLSession: URLSession(configuration: configuration))
        }
        let profile = try app.addRemoteProfile(name: "Startup", address: "https://start-\(UUID().uuidString).multi.fixture.invalid")
        IOSMultiServerFixtureTransport.set([PreviewData.session(id: "first")], for: profile.baseURL)
        IOSMultiServerFixtureTransport.blockOffscreenLists(at: profile.baseURL)
        try launch.credentials.save(.init(token: "fixture", tokenId: "fixture"), for: profile.credentialKey)
        await app.activate(profile)
        defer { app.deactivate() }
        let deadline = ContinuousClock.now + .seconds(3)
        while app.store?.hasLoadedSessions != true, ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertEqual(app.store?.sessions.first?.id, "first")
        for _ in 0..<100 { await Task.yield() }
        let requests = IOSMultiServerFixtureTransport.requests(at: profile.baseURL)
        XCTAssertEqual(requests.filter { $0 == "/api/sessions" }.count, 1)
        for path in ["/api/recaps", "/api/sessions/done", "/api/sessions/archived", "/api/up-next"] {
            XCTAssertFalse(requests.contains(path), path)
        }
    }

    func testIsolationAliasesAndArgumentOverride() {
        XCTAssertTrue(IOSLaunchEnvironment.configuration(arguments: [], environment: ["TEST_RUNNER_SHEPHERD_ISOLATED": "1"]).isIsolated)
        XCTAssertFalse(IOSLaunchEnvironment.configuration(arguments: ["-ShepherdIsolated", "0"], environment: ["SHEPHERD_ISOLATED": "1"]).isIsolated)
    }
    func testIsolatedStorageIsPrivateAndReadOnly() throws {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel()
        XCTAssertTrue(app.profiles.isEmpty)
        XCTAssertTrue(app.loadsListsOnDemand)
        XCTAssertFalse(app.allowsQueueRecomputation)
        XCTAssertFalse(app.allowsTerminalInput)
        XCTAssertNotNil(app.liveRequestAudit)
        XCTAssertNotEqual(app.composerDefaults, UserDefaults.standard)
    }
    func testStorageFailureFailsClosed() {
        XCTAssertThrowsError(try IOSLaunchEnvironment(configuration: .init(isIsolated: true), makeDefaults: { _ in nil }))
    }
    func testNormalLaunchAllowsRepliesWithoutReadOnlyAudit() throws {
        let launch = try IOSLaunchEnvironment(configuration: .init())
        let app = launch.makeModel()
        XCTAssertTrue(app.allowsTerminalInput)
        XCTAssertNil(app.liveRequestAudit)
        XCTAssertTrue(app.loadsListsOnDemand)
        XCTAssertFalse(app.allowsQueueRecomputation)
    }
    func testActivationRegistersOnlyReadingModels() async throws {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel()
        let profile = try app.addRemoteProfile(name: "Fixture", address: "http://127.0.0.1:1")
        await app.activate(profile)
        defer { app.deactivate() }
        XCTAssertNotNil(app.extension(SidebarModel.self))
        XCTAssertNotNil(app.extension(DetailModel.self))
        XCTAssertNotNil(app.extension(HerdSignals.self))
        XCTAssertNotNil(app.extension(PlanModel.self))
        XCTAssertNotNil(app.extension(QueuesModel.self))
        XCTAssertNotNil(app.extension(MergeModel.self))
        XCTAssertNotNil(app.extension(ReadOnlySidebarRecovery.self))
        XCTAssertNotNil(app.extension(ActionsModel.self)) // recap reads
        XCTAssertNotNil(app.extension(IOSTerminalController.self))
        XCTAssertNotNil(app.extension(BackendRecoveryModel.self))
        XCTAssertNil(app.extension(NotificationsModel.self))
    }

}
