import XCTest

/// Launch → the welcome screen offers both connection routes.
/// The app is forced to English so the assertions can name the EN copy; the DE
/// catalog is covered by StringCatalogTests.
final class WelcomeSmokeUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
            // Empty the persisted profile keys for this launch so the welcome
            // screen shows even on a machine that has already connected once.
            "-run.shepherd.mac.profiles", "",
            "-run.shepherd.mac.activeProfileID", "",
        ]
        app.launch()
    }

    override func tearDownWithError() throws {
        app.terminate()
        app = nil
    }

    func testWelcomeShowsBothCards() {
        XCTAssertTrue(
            app.staticTexts["Run on this Mac"].waitForExistence(timeout: 15),
            "the local card should be on screen")
        XCTAssertTrue(
            app.staticTexts["Connect to a remote server"].exists,
            "the remote card should be on screen")
    }

    func testWelcomeCardsAreIdentifiable() {
        XCTAssertTrue(
            app.descendants(matching: .any)["welcome-local-card"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any)["welcome-remote-card"].exists)
    }

    func testRemoteAddressFieldRejectsPlainHttp() {
        let field = app.textFields["welcome-remote-url"]
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.click()
        field.typeText("http://shepherd.example.com")
        app.buttons["welcome-remote-connect"].click()

        let error = app.staticTexts.containing(
            NSPredicate(format: "value CONTAINS 'https'")).firstMatch
        XCTAssertTrue(
            error.waitForExistence(timeout: 5),
            "the insecure-address error should appear")
    }
}
