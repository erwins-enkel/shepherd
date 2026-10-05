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
    func testSessionListNewTaskOpensComposer() {
        app.launchArguments += ["-ShepherdSessionListFixture", "1"]
        app.launch()
        let newTask = app.buttons["new-task"]
        XCTAssertTrue(newTask.waitForExistence(timeout: 10))
        XCTAssertEqual(newTask.label, "+ Neue Aufgabe")
        XCTAssertGreaterThanOrEqual(newTask.frame.width, 44)
        XCTAssertGreaterThanOrEqual(newTask.frame.height, 44)
        let repos = app.buttons["show-repos"]
        if repos.exists {
            XCTAssertGreaterThan(newTask.frame.minX, repos.frame.minX)
        } else {
            XCTAssertTrue(app.descendants(matching: .any)["herd-lenses-top"].exists)
        }
        XCTAssertTrue(newTask.isHittable)
        newTask.tap()
        XCTAssertTrue(app.descendants(matching: .any)["compose.sheet"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.textViews["compose.prompt"].exists)
    }
    func testReadOnlySessionListHidesNewTask() {
        app.launchArguments += ["-ShepherdSessionListFixture", "1", "-ShepherdReadOnlyFixture", "1"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["session-list"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["new-task"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["compose.sheet"].exists)
    }
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
        mic.tap()
        let stop = app.descendants(matching: .any)["compose.voice.stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        // This activates the toggle with taps, without the hold/drag path above.
        XCTAssertTrue(app.descendants(matching: .any)["compose.voice.preview"].waitForExistence(timeout: 5))
        let elapsed = app.staticTexts["compose.voice.elapsed"]
        let advanced = expectation(for: NSPredicate(format: "exists == true AND label != '00:00'"), evaluatedWith: elapsed)
        wait(for: [advanced], timeout: 5)
        stop.tap()
        XCTAssertTrue(mic.waitForExistence(timeout: 5))
        XCTAssertTrue((app.textViews["compose.prompt"].value as? String)?.contains("Dark-Mode") == true)
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
    func testDollarTokenShowsCodexCommandsWhileClaudeIsSelected() {
        app.launch()
        let prompt = app.textViews["compose.prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 10)); prompt.tap(); prompt.typeText("$")
        let command = app.buttons["compose.command.codex-review"]
        XCTAssertTrue(command.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["compose.command.review"].exists)
        command.tap()
        XCTAssertEqual(prompt.value as? String, "$codex-review ")
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
    func testStartDuringUploadStartsAutomatically() {
        app.launchArguments += ["-ShepherdComposeAttachmentFixture", "1", "-ShepherdComposeSlowUploadFixture", "1"]
        app.launch()
        XCTAssertTrue(app.staticTexts["compose.upload.hint"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["compose.upload.status"].exists)
        let start = app.descendants(matching: .any)["compose.submit"]
        XCTAssertTrue(start.isEnabled)
        start.tap()
        let armed = expectation(for: NSPredicate(format: "label == %@", "Automatischen Start abbrechen"), evaluatedWith: start)
        wait(for: [armed], timeout: 5)
        XCTAssertTrue(app.staticTexts["compose.fixture.created"].waitForExistence(timeout: 20))
    }
    func testAttachMenuPhotosPresentsLibrary() { assertAttachItemCoversCompose("Fotos") }
    func testAttachMenuFilesPresentsImporter() { assertAttachItemCoversCompose("Dateien") }
    /// The pickers render out of process, so the signal is the prompt they cover, not their contents.
    private func assertAttachItemCoversCompose(_ item: String) {
        app.launch()
        let prompt = app.textViews["compose.prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 10))
        XCTAssertTrue(prompt.isHittable)
        let attach = app.buttons["compose.attach"]
        XCTAssertTrue(attach.waitForExistence(timeout: 5)); attach.tap()
        let entry = app.buttons[item]
        XCTAssertTrue(entry.waitForExistence(timeout: 5)); entry.tap()
        let covered = expectation(for: NSPredicate(format: "exists == false OR hittable == false"), evaluatedWith: prompt)
        wait(for: [covered], timeout: 10)
    }
}
