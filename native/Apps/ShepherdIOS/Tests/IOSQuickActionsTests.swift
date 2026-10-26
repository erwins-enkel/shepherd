import XCTest
@testable import ShepherdIOS

@MainActor
final class IOSQuickActionsTests: XCTestCase {
    func testInfoPlistDeclaresEveryQuickActionWithLocalizedTitles() throws {
        let items = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "UIApplicationShortcutItems") as? [[String: String]])
        XCTAssertEqual(items.map { $0["UIApplicationShortcutItemType"] }, IOSQuickAction.allCases.map(\.rawValue))
        XCTAssertEqual(items.map { $0["UIApplicationShortcutItemIconSymbolName"] }, ["mic.fill", "plus"])
        for (locale, titles) in ["en": ["Dictate Task", "New Task"], "de": ["Aufgabe diktieren", "Neue Aufgabe"]] {
            let path = try XCTUnwrap(Bundle.main.path(forResource: "InfoPlist", ofType: "strings", inDirectory: nil, forLocalization: locale))
            let strings = try XCTUnwrap(NSDictionary(contentsOfFile: path) as? [String: String])
            XCTAssertEqual(items.map { $0["UIApplicationShortcutItemTitle"].flatMap { strings[$0] } }, titles, locale)
        }
    }

    func testUnknownTypeIsIgnoredAndResetDropsThePendingAction() {
        let actions = IOSQuickActions()
        XCTAssertFalse(actions.receive(type: "run.shepherd.quick-action.unknown"))
        XCTAssertNil(actions.pending)
        XCTAssertTrue(actions.receive(type: IOSQuickAction.dictateTask.rawValue))
        XCTAssertEqual(actions.pending, .dictateTask)
        actions.reset()
        XCTAssertNil(actions.pending)
    }
}
