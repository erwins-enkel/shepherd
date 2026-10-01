import XCTest

@MainActor
final class IOSComposeUITests: XCTestCase {
    private let app = XCUIApplication()
    override func setUp() {
        continueAfterFailure = false
        app.launchArguments = ["-ShepherdIsolated", "1", "-ShepherdComposeFixture", "1", "-AppleLanguages", "(de)", "-AppleLocale", "de_DE"]
        app.launchEnvironment = ["SHEPHERD_ISOLATED":"1"]
    }
    override func tearDown() { app.terminate() }
    func testHoldLockFinalizeAndStartUsesFixtureServer() {
        app.launch()
        let mic = app.descendants(matching: .any)["compose.voice.mic.idle"]
        XCTAssertTrue(mic.waitForExistence(timeout: 10), app.descendants(matching: .any).allElementsBoundByIndex.filter { $0.identifier.hasPrefix("compose.") }.map { "\($0.elementType.rawValue):\($0.identifier)" }.joined(separator: ","))
        let from = mic.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let to = from.withOffset(CGVector(dx: 0, dy: -100))
        from.press(forDuration: 1, thenDragTo: to)
        let stop = app.descendants(matching: .any)["compose.voice.stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5)); stop.tap()
        XCTAssertTrue(app.descendants(matching: .any)["compose.voice.mic.idle"].waitForExistence(timeout: 5))
        let prompt = app.textViews["compose.prompt"]
        XCTAssertTrue((prompt.value as? String)?.contains("Dark-Mode") == true)
        XCTAssertTrue(app.descendants(matching: .any)["compose.submit"].isEnabled); app.descendants(matching: .any)["compose.submit"].tap()
        XCTAssertTrue(app.staticTexts["compose.fixture.created"].waitForExistence(timeout: 10))
    }
    func testCancelDiscardsAndAccessibleToggleDoesNotRequireHold() {
        app.launch()
        let mic = app.descendants(matching: .any)["compose.voice.mic.idle"]
        XCTAssertTrue(mic.waitForExistence(timeout: 10), app.descendants(matching: .any).allElementsBoundByIndex.filter { $0.identifier.hasPrefix("compose.") }.map { "\($0.elementType.rawValue):\($0.identifier)" }.joined(separator: ","))
        let from = mic.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        from.press(forDuration: 1, thenDragTo: from.withOffset(CGVector(dx: -110, dy: 0)))
        XCTAssertTrue(app.descendants(matching: .any)["compose.voice.mic.idle"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any)["compose.submit"].isEnabled)
        XCTAssertEqual(app.descendants(matching: .any)["compose.voice.mic.idle"].label, "Diktieren")
    }
    func testIssueOnlyPromptCanStartAndEngineControlsExist() {
        app.launch()
        XCTAssertTrue(app.buttons["compose.issues.open"].waitForExistence(timeout: 10))
        app.buttons["compose.issues.open"].tap()
        let issue = app.buttons["compose.issue.412"]
        XCTAssertTrue(issue.waitForExistence(timeout: 10)); issue.tap()
        XCTAssertTrue(app.descendants(matching: .any)["compose.submit"].isEnabled)
        app.buttons["compose.engine.open"].tap()
        XCTAssertTrue(app.otherElements["compose.planGate"].waitForExistence(timeout: 5) || app.switches["compose.planGate"].exists)
    }
    func testFailedAttachmentBlocksStartUntilRetrySucceeds() {
        app.launchArguments += ["-ShepherdComposeAttachmentFixture", "1"]
        app.launch()
        let retry = app.buttons["compose.attachment.retry"]
        XCTAssertTrue(retry.waitForExistence(timeout: 10))
        let start = app.descendants(matching: .any)["compose.submit"]
        XCTAssertFalse(start.isEnabled)
        retry.tap()
        XCTAssertTrue(retry.waitForNonExistence(timeout: 5))
        let ready = expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: start)
        wait(for: [ready], timeout: 10)
        start.tap()
        XCTAssertTrue(app.staticTexts["compose.fixture.created"].waitForExistence(timeout: 10))
    }
}
