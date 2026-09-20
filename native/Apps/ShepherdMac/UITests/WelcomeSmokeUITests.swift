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
            // Profile isolation does not isolate AppKit's saved-window restoration.
            // A prior no-window launch must not prevent RootView's task from running.
            "-ApplePersistenceIgnoreState", "YES",
            "-NSQuitAlwaysKeepsWindows", "NO",
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
            // Isolated: a private, empty UserDefaults suite and an in-memory
            // credential store instead of the operator's profiles and the login
            // Keychain — see `LaunchEnvironment`. This replaces the two blanked
            // profile keys this suite used to pass, and covers what they never
            // could: the Keychain read behind a restored profile blocks on a
            // SecurityAgent dialog no unattended run can answer.
            "-ShepherdIsolated", "1",
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
