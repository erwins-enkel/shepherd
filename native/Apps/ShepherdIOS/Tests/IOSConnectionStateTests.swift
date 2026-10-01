import XCTest
import ShepherdKit
@testable import ShepherdIOS

@MainActor
final class IOSConnectionStateTests: XCTestCase {
    func testFirstRunAndConnectingHaveSeparatePresentation() {
        XCTAssertTrue(ConnectionStatusView.isFirstRun(.firstRunPending))
        XCTAssertFalse(ConnectionStatusView.isFirstRun(.needsLogin))
        XCTAssertTrue(ConnectionStatusView.isConnecting(.connecting))
        XCTAssertFalse(ConnectionStatusView.isConnecting(.live))
    }
}
