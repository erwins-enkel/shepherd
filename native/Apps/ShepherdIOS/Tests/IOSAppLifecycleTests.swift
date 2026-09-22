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
    func testSuspendedPresenceCannotRecoverAfterBackgrounding() async {
        var gate: CheckedContinuation<Void, Never>?
        var values: [Bool] = []
        var recoveries = 0
        let lifecycle = IOSAppLifecycle(setActive: { active in
            values.append(active)
            if active { await withCheckedContinuation { gate = $0 } }
        }, onForegroundRecovery: { recoveries += 1 })
        let foreground = Task { await lifecycle.update(.active) }
        for _ in 0..<100 where gate == nil { await Task.yield() }
        XCTAssertNotNil(gate)
        let background = Task { await lifecycle.update(.background) }
        for _ in 0..<10 { await Task.yield() }
        gate?.resume()
        await foreground.value
        await background.value
        XCTAssertEqual(values, [true, false])
        XCTAssertEqual(recoveries, 0)
    }

}
