import XCTest
@testable import ShepherdIOS

@MainActor
final class IOSAppLifecycleTests: XCTestCase {
    func testOrderedPresenceAndCoalescedPhases() async {
        var values: [Bool] = []
        var recoveries = 0
        let lifecycle = IOSAppLifecycle(setActive: { values.append($0) }, onForegroundRecovery: { recoveries += 1 })
        await lifecycle.update(.active)
        await lifecycle.update(.active)
        await lifecycle.update(.inactive)
        await lifecycle.update(.background)
        await lifecycle.update(.active)
        XCTAssertEqual(values, [true, false, true])
        XCTAssertEqual(recoveries, 2)
    }
    func testLiveRecoveryOnlyWhileActive() async {
        var recoveries = 0
        let lifecycle = IOSAppLifecycle(setActive: { _ in }, onForegroundRecovery: { recoveries += 1 })
        await lifecycle.update(.active)
        await lifecycle.connectionDidChange(.live)
        await lifecycle.connectionDidChange(.live)
        XCTAssertEqual(recoveries, 2)
        await lifecycle.update(.background)
        await lifecycle.connectionDidChange(.offline(message: "offline"))
        await lifecycle.connectionDidChange(.live)
        XCTAssertEqual(recoveries, 2)
    }
}
