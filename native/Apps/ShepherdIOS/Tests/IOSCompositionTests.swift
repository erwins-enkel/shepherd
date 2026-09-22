import XCTest
import ShepherdAppCore
import ShepherdKit
@testable import ShepherdIOS

@MainActor
final class IOSCompositionTests: XCTestCase {
    func testIsolationAliasesAndArgumentOverride() {
        XCTAssertTrue(IOSLaunchEnvironment.configuration(arguments: [], environment: ["TEST_RUNNER_SHEPHERD_ISOLATED": "1"]).isIsolated)
        XCTAssertFalse(IOSLaunchEnvironment.configuration(arguments: ["-ShepherdIsolated", "0"], environment: ["SHEPHERD_ISOLATED": "1"]).isIsolated)
    }
    func testIsolatedStorageIsPrivateAndReadOnly() throws {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel()
        XCTAssertTrue(app.profiles.isEmpty)
        XCTAssertFalse(app.allowsQueueRecomputation)
        XCTAssertFalse(app.allowsTerminalInput)
        XCTAssertNotNil(app.liveRequestAudit)
        XCTAssertNotEqual(app.composerDefaults, UserDefaults.standard)
    }
    func testStorageFailureFailsClosed() {
        XCTAssertThrowsError(try IOSLaunchEnvironment(configuration: .init(isIsolated: true), makeDefaults: { _ in nil }))
    }
}
