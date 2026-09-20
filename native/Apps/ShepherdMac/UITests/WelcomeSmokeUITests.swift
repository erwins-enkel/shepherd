import XCTest

/// Launch → the welcome screen offers both connection routes.
/// The app is forced to English so the assertions can name the EN copy; the DE
/// catalog is covered by StringCatalogTests.
@MainActor
final class WelcomeSmokeUITests: XCTestCase {
    private let harness = IsolatedUITestHarness()
    private var app: XCUIApplication { harness.application }

    override func setUp() async throws {
        continueAfterFailure = false
        harness.launch()
    }

    override func tearDown() async throws {
        harness.shutdown()
    }

    func testWelcomeShowsBothCards() {
        XCTAssertTrue(
            app.staticTexts["Run on this Mac"].waitForExistence(timeout: 15),
            "the local card should be on screen")
        XCTAssertTrue(
            app.staticTexts["Connect to a remote server"].exists,
            "the remote card should be on screen")
    }

    /// The isolation is not an internal detail: an isolated launch has to come
    /// up on an *empty* welcome screen. A saved-servers section here would mean
    /// this launch had read the operator's own profiles after all.
    func testIsolatedLaunchListsNoSavedServers() {
        XCTAssertTrue(
            app.descendants(matching: .any)["welcome-local-card"].waitForExistence(timeout: 15),
            "the welcome screen should be up")
        XCTAssertFalse(
            app.descendants(matching: .any)["welcome-saved-servers"].exists,
            "an isolated launch must not list the operator's saved servers")
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
