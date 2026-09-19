import XCTest

/// The two variables that arm `LiveSmokeUITests`, read in both spellings:
/// `xcodebuild` forwards a `TEST_RUNNER_`-prefixed variable into the test
/// runner process and strips the prefix on the way — but not on every
/// toolchain, so both are accepted. Mirrors `LiveServerEnvironment` in the unit
/// bundle. Never hard-code the values: they are an operator's real server and
/// real password.
enum LiveUITestEnvironment {
    static var baseURL: String? { value("SHEPHERD_LIVE_BASE_URL") }
    static var password: String? { value("SHEPHERD_LIVE_PASSWORD") }

    private static func value(_ name: String) -> String? {
        let environment = ProcessInfo.processInfo.environment
        for candidate in [name, "TEST_RUNNER_\(name)"] {
            guard let raw = environment[candidate] else { continue }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }
}

/// The end-to-end run the other UI tests cannot do: launch, sign in to a *real*
/// server, and land on the session list — unattended, and without touching the
/// operator's Keychain or saved profiles.
///
/// The app is launched isolated (see `LaunchEnvironment`), so the token
/// `ProfileSetup.login` mints lands in an `InMemoryCredentialStore` and the
/// profile in a throwaway `UserDefaults` suite; `-ShepherdRevokeOnExit 1` gives
/// that token back to the server when `tearDown` terminates the app, so a run
/// leaves nothing behind on either side.
///
/// Skipped wholesale — and so silent in CI, which has no server — unless
/// `SHEPHERD_LIVE_BASE_URL` and `SHEPHERD_LIVE_PASSWORD` are both set:
///
///     TEST_RUNNER_SHEPHERD_LIVE_BASE_URL=https://…:7330/ \
///     TEST_RUNNER_SHEPHERD_LIVE_PASSWORD=… \
///       native/scripts/test-app.sh -only-testing:ShepherdUITests
final class LiveSmokeUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let baseURL = LiveUITestEnvironment.baseURL,
            let password = LiveUITestEnvironment.password
        else {
            throw XCTSkip(
                "set SHEPHERD_LIVE_BASE_URL and SHEPHERD_LIVE_PASSWORD (or their "
                    + "TEST_RUNNER_-prefixed spellings) to run the live UI smoke test")
        }

        app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
            "-ShepherdIsolated", "1",
            "-ShepherdRevokeOnExit", "1",
        ]
        // The app under test does not inherit this process's environment, so
        // the seed is handed over explicitly. It never reaches disk: the app
        // uses it for one `ProfileSetup.login` call and holds the result in
        // memory.
        app.launchEnvironment["SHEPHERD_LIVE_BASE_URL"] = baseURL
        app.launchEnvironment["SHEPHERD_LIVE_PASSWORD"] = password
        app.launch()
    }

    override func tearDownWithError() throws {
        // Ends the run. Note what it does NOT do: deliver
        // `NSApplicationWillTerminate`, so the app's own quit handler — and with
        // it the `-ShepherdRevokeOnExit 1` revocation — does not run here.
        // Verified, including via SIGTERM first, which AppKit did not turn into
        // a quit either. The handler is still right for a real quit (⌘Q), and
        // the cost of it not firing is bounded and visible: one access token
        // named "Shepherd for Mac (<host>)" per live run, revocable from the
        // server's token list.
        app?.terminate()
        app = nil
    }

    func testLiveLaunchLandsOnTheSessionList() {
        let sidebar = app.descendants(matching: .any)["session-sidebar"]
        let newSession = app.descendants(matching: .any)["toolbar-new-session"]
        XCTAssertTrue(
            waitForAny([sidebar, newSession], timeout: 90),
            "the main window should have replaced the welcome screen")

        XCTAssertFalse(
            app.descendants(matching: .any)["login-password"].exists,
            "a seeded sign-in must not leave a login sheet up")
        XCTAssertFalse(
            app.descendants(matching: .any)["welcome-local-card"].exists,
            "the welcome screen should be gone once a profile is active")

        // A server with sessions lists rows; a server without shows the empty
        // state. Both are a connection that worked — only neither is a failure.
        let firstRow = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'session-row-'"))
            .firstMatch
        let emptyState = app.staticTexts["No sessions yet."]
        XCTAssertTrue(
            waitForAny([firstRow, emptyState], timeout: 60),
            "the sidebar should show either a session row or the empty state")
    }

    /// Polls, because `waitForExistence` on one element cannot express "either
    /// of these", and waiting them out in sequence would spend the first
    /// element's whole timeout whenever the second is the one that appears.
    private func waitForAny(_ elements: [XCUIElement], timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if elements.contains(where: { $0.exists }) { return true }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline
        return false
    }
}
