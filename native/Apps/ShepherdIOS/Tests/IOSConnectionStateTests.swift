import XCTest
import ShepherdKit
@testable import ShepherdIOS

final class IOSConnectionStateTests: XCTestCase {
    func testFirstRunAndConnectingHaveSeparatePresentation() {
        XCTAssertTrue(ConnectionStatusView.isFirstRun(.firstRunPending))
        XCTAssertFalse(ConnectionStatusView.isFirstRun(.needsLogin))
        XCTAssertTrue(ConnectionStatusView.isConnecting(.connecting))
        XCTAssertFalse(ConnectionStatusView.isConnecting(.live))
    }
}
