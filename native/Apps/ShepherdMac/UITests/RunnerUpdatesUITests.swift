import XCTest

@MainActor final class RunnerUpdatesUITests: XCTestCase {
    private let harness = IsolatedUITestHarness()
    override func tearDown() async throws { harness.shutdown() }

    func testBothUpdatesAppearBeforeOpeningSettingsAndOpenNativeDetails() throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["SHEPHERD_RUNNER_UPDATE_FIXTURE"] == "1"
            || environment["TEST_RUNNER_SHEPHERD_RUNNER_UPDATE_FIXTURE"] == "1",
            let url = LiveUITestEnvironment.baseURL,
            let password = LiveUITestEnvironment.password else {
            throw XCTSkip("Requires test/fixtures/runner-updates-ui-server.ts and its isolated fixture environment")
        }
        continueAfterFailure = false
        harness.launch(liveEnvironment: ["SHEPHERD_LIVE_BASE_URL": url, "SHEPHERD_LIVE_PASSWORD": password])
        let app = harness.application
        let herdr = app.buttons["runner-update-herdr"]
        let codex = app.buttons["runner-update-codex"]
        XCTAssertTrue(herdr.waitForExistence(timeout: 30))
        XCTAssertTrue(codex.waitForExistence(timeout: 10))
        XCTAssertTrue(herdr.label.contains("0.8.2") && herdr.label.contains("0.9.3"))
        XCTAssertTrue(codex.label.contains("0.160.1") && codex.label.contains("0.162.1"))
        codex.click()
        XCTAssertTrue(app.descendants(matching: .any)["runner-update-details"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["runner-update-server"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["runner-herdr-versions"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["runner-codex-versions"].exists)
        XCTAssertTrue(app.buttons["runner-herdr-install"].exists)
        XCTAssertTrue(app.buttons["runner-codex-install"].exists)
        app.buttons["runner-herdr-install"].click()
        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 5))
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(app.buttons["Continue"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["runner-update-details"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Runner updates — native details"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
