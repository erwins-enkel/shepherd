import XCTest

@MainActor
final class ShepherdIOSUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        app.launchArguments = ["-ShepherdIsolated", "1"]
        app.launchEnvironment = ["SHEPHERD_ISOLATED": "1"]
    }

    override func tearDown() { app.terminate() }

    func testRemoteFormReachesPasswordWithoutLocalServerControls() {
        app.launch()
        XCTAssertTrue(app.buttons["add-server"].waitForExistence(timeout: 10))
        app.buttons["add-server"].tap()
        let address = app.textFields["server-address"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["connect-server"].isEnabled)
        address.tap()
        address.typeText("https://example.invalid")
        app.buttons["connect-server"].tap()
        XCTAssertTrue(app.secureTextFields["login-password"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["login-submit"].isEnabled)
        for identifier in ["run-local-server", "terminal-input", "compose.submit", "merge-submit"] {
            XCTAssertFalse(app.buttons[identifier].exists)
        }
    }

    func testRemotePlainHTTPIsRejectedBeforeLogin() {
        app.launch()
        XCTAssertTrue(app.buttons["add-server"].waitForExistence(timeout: 10))
        app.buttons["add-server"].tap()
        let address = app.textFields["server-address"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap()
        address.typeText("http://example.invalid")
        app.buttons["connect-server"].tap()
        XCTAssertTrue(address.exists)
        XCTAssertFalse(app.secureTextFields["login-password"].exists)
    }

    func testGermanAccessibilitySizeRetainsUsableConnectionControls() {
        app.launchArguments += ["-AppleLanguages", "(de)", "-AppleLocale", "de_DE",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        XCTAssertTrue(app.buttons["add-server"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["add-server"].isHittable)
        app.buttons["add-server"].tap()
        XCTAssertTrue(app.textFields["server-address"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["server-address"].isHittable)
    }
}
