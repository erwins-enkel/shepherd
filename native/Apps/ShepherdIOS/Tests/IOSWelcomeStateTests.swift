import XCTest
import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSWelcomeStateTests: XCTestCase {
    func testRemoteSecurityAndLoopback() throws {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel()
        XCTAssertThrowsError(try app.addRemoteProfile(name: "", address: "http://example.com"))
        let first = try app.addRemoteProfile(name: "", address: "mini.ts.net")
        let second = try app.addRemoteProfile(name: "Duplicate", address: "https://MINI.ts.net/path")
        XCTAssertEqual(first.id, second.id)
        XCTAssertNoThrow(try app.addRemoteProfile(name: "", address: "http://127.0.0.1:7330"))
    }
    func testBusySheetAndReplacementProtection() {
        var state = LoginSheetState()
        state.busy = true
        XCTAssertFalse(state.canDismiss)
        state.busy = false
        XCTAssertTrue(state.canDismiss)
    }
}
