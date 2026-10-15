import XCTest
import ShepherdKit
import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSAppBadgeTests: XCTestCase {
    func testCountAndSumIncludeOnlyBlockedAndIdle() {
        let sessions = [SessionStatusKnown.running, .idle, .blocked, .done, .archived].map {
            PreviewData.session(id: $0.rawValue, status: .init(known: $0))
        }
        var unknown = sessions[0]
        unknown.status = .init(unknown: "future-status")
        XCTAssertEqual(IOSAppBadge.count(sessions + [unknown]), 2)
        XCTAssertEqual(IOSAppBadge.sum([sessions, [], [sessions[1]]]), 3)
        XCTAssertEqual(IOSAppBadge.sum([]), 0)
    }

    func testWritesOnlyChangesAndRewritesOnBackground() async {
        var writes: [Int] = []
        let badge = IOSAppBadge { writes.append($0) }
        await badge.update(2, enabled: true)
        await badge.update(2, enabled: true)
        await badge.update(0, enabled: true)
        await badge.update(0, enabled: true, background: true)
        await badge.update(0, enabled: true)
        await badge.update(0, enabled: true)
        XCTAssertEqual(writes, [2, 0, 0, 0])
    }

    func testIsolatedLaunchNeverWritesOrArmsElision() async {
        var writes: [Int] = []
        let badge = IOSAppBadge { writes.append($0) }
        await badge.update(2, enabled: false)
        await badge.update(2, enabled: false, background: true)
        XCTAssertTrue(writes.isEmpty)
        await badge.update(2, enabled: true)
        XCTAssertEqual(writes, [2])
    }
}
