import XCTest
import ShepherdAppCore
import ShepherdKit
@testable import ShepherdIOS

@MainActor
final class IOSSessionViewTests: XCTestCase {
    func testActivityStatesAndServerOrdering() {
        XCTAssertEqual(ActivityView.phase(for: .loading), .loading)
        XCTAssertEqual(ActivityView.phase(for: .failed("offline")), .failed("offline"))
        XCTAssertEqual(ActivityView.phase(for: .ready([])), .empty(L.t("activity_empty")))
        let entry = ActivityEntry(ts: 1, tool: "Read", summary: "a", status: .init(known: .ok))
        XCTAssertEqual(ActivityView.phase(for: .ready([entry])), .content)
    }
    func testDetailIdentityChangesBetweenModels() {
        let first = DetailModel(loaders: .stubbed())
        let second = DetailModel(loaders: .stubbed())
        XCTAssertNotEqual(DetailTaskKey(session: "same", model: first), DetailTaskKey(session: "same", model: second))
        XCTAssertEqual(SessionStatusStyle.label(.init(unknown: "future")), "FUTURE")
    }
}
