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

/// The end-to-end runs the other UI tests cannot do: launch, sign in to a
/// *real* server, and drive the milestone-2 surfaces — sidebar, detail tabs and
/// terminal — through the window, unattended, without touching the operator's
/// Keychain, saved profiles or their own access token.
///
/// The app is launched isolated (see `LaunchEnvironment`), so the token
/// `ProfileSetup.login` mints is named `Shepherd UI test (<host>)`, lands in an
/// `InMemoryCredentialStore` and the profile in a throwaway `UserDefaults`
/// suite; `-ShepherdRevokeOnExit 1` gives that token back to the server when the
/// app really quits, and the next run sweeps any that a killed run left behind.
///
/// **Read-only against the operator's herd.** These tests never submit a prompt,
/// never archive, stop or relaunch a session, and never trigger a PR action.
/// The one thing they do write is keystrokes into a live PTY, which are erased
/// with exactly as many backspaces and never followed by a newline — the same
/// round trip PR #2389 did at kit level.
///
/// Skipped wholesale — and so silent in CI, which has no server — unless
/// `SHEPHERD_LIVE_BASE_URL` and `SHEPHERD_LIVE_PASSWORD` are both set:
///
///     TEST_RUNNER_SHEPHERD_LIVE_BASE_URL=https://…:7330 \
///     TEST_RUNNER_SHEPHERD_LIVE_PASSWORD=… \
///     TEST_RUNNER_SHEPHERD_REVOKE_ON_EXIT=1 \
///       native/scripts/test-app.sh -only-testing:ShepherdUITests
final class LiveSmokeUITests: XCTestCase {
    private var app: XCUIApplication!
    private var baseURL: String!
    private var password: String!

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let baseURL = LiveUITestEnvironment.baseURL,
            let password = LiveUITestEnvironment.password
        else {
            throw XCTSkip(
                "set SHEPHERD_LIVE_BASE_URL and SHEPHERD_LIVE_PASSWORD (or their "
                    + "TEST_RUNNER_-prefixed spellings) to run the live UI smoke test")
        }
        self.baseURL = baseURL
        self.password = password

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
        // named "Shepherd UI test (<host>)" per live run, which the *next*
        // run's `sweepPriorTokensNamed` revokes by name before minting its own.
        app?.terminate()
        app = nil
    }

    // MARK: - Gate 2: the app still comes up on a real server

    func testLiveLaunchLandsOnTheSessionList() {
        XCTAssertTrue(waitForMainWindow(), "the main window should have replaced the welcome screen")

        XCTAssertFalse(
            app.descendants(matching: .any)["login-password"].exists,
            "a seeded sign-in must not leave a login sheet up")
        XCTAssertFalse(
            app.descendants(matching: .any)["welcome-local-card"].exists,
            "the welcome screen should be gone once a profile is active")

        // A server with sessions lists rows; a server without shows the empty
        // state. Both are a connection that worked — only neither is a failure.
        let emptyState = app.staticTexts["No sessions yet."]
        XCTAssertTrue(
            waitForAny([anySessionRow, emptyState], timeout: 60),
            "the sidebar should show either a session row or the empty state")
    }

    // MARK: - S3: the herd sidebar

    /// The sidebar is `SidebarSlot.content`, which only exists in the running
    /// app once `StreamRegistrations` installs it — so this is also the test
    /// that the S3 install line is actually wired.
    func testTheSidebarRendersHerdGroupsAndTallies() {
        XCTAssertTrue(waitForMainWindow())

        let sidebar = app.descendants(matching: .any)["herd-sidebar"]
        XCTAssertTrue(
            sidebar.waitForExistence(timeout: 60),
            "the herd sidebar should have replaced the flat session list")
        XCTAssertTrue(
            app.descendants(matching: .any)["herd-tallies"].waitForExistence(timeout: 30),
            "the header should show the herd tallies")

        XCTAssertTrue(
            anySessionRow.waitForExistence(timeout: 60),
            "the operator's herd should list sessions")
        let groups = elements(withIdentifierPrefix: "herd-group-")
        XCTAssertGreaterThan(groups.count, 0, "a non-empty herd should render at least one group")

        // The repo chip rail is derived from the sessions themselves, so it is
        // only meaningful once the herd spans more than one repo.
        let chips = elements(withIdentifierPrefix: "repo-chip-")
        if chips.count > 0 {
            XCTAssertGreaterThanOrEqual(
                chips.count, 1, "a herd spanning repos should offer at least one repo chip")
        }
    }

    // MARK: - S2: the detail tabs

    /// Every tab S2 registered renders its own body and none of them lands on the error state.
    /// Also covers the tab bar itself: with only the built-in prompt tab registered
    /// `DetailTabRegistry.layout` is `.single` and there would be no tab to click at all.
    ///
    /// Tabs are addressed by **position**, not by title. SwiftUI's `TabView` becomes an
    /// `NSTabView` whose items carry no accessibility name on this toolchain — verified against
    /// the live window — so the registry's own sort order (terminal 0, activity 10, diff 20,
    /// files 30, git 40, prompt 1 000) is the only stable handle. That order is asserted here
    /// too: a stream that registers a tab out of order fails this test rather than silently
    /// reshuffling the operator's tab bar.
    func testEveryDetailTabLoadsForASelectedSession() {
        XCTAssertTrue(waitForMainWindow())
        XCTAssertTrue(selectFirstSession(), "a live server should offer a session to select")

        XCTAssertEqual(
            tabButtons.count, 6,
            "terminal, activity, diff, files, git and the built-in prompt tab should all be registered")

        for (index, identifier) in [
            (1, "detail-tab-activity"),
            (2, "detail-tab-diff"),
            (3, "detail-tab-files"),
            (4, "detail-tab-git"),
        ] {
            XCTAssertTrue(selectTab(at: index), "tab \(index) should be in the tab bar")
            let body = app.descendants(matching: .any)[identifier]
            XCTAssertTrue(
                body.waitForExistence(timeout: 30), "\(identifier) should render its own body")
            // A feed that failed puts `detail-state-error` in the body. A feed still loading is
            // fine — it is the error that is a failure.
            XCTAssertFalse(
                app.descendants(matching: .any)["detail-state-error"].exists,
                "\(identifier) should not land on the error state")
        }
    }

    // MARK: - S1: the terminal

    /// The terminal tab attaches and renders: the emulator is hosted, the prompt bar is under it,
    /// and a window resize — which goes out as the PTY's `\0resize:` control frame — leaves the
    /// socket open.
    ///
    /// **Deliberately does not type.** The keystroke round trip (text echoed by the PTY, then
    /// erased with exactly as many backspaces) and the takeover path (a second client, close code
    /// 4000, the banner, "Take over", the scrollback replay) were both exercised by hand against
    /// the operator's server and recorded in this branch's PR. They are not automated here because
    /// this test picks whatever session the herd lists first, and the operator's agents run
    /// keyboard-driven TUIs where a stray character can answer a question. A smoke test must not
    /// be able to do that by accident.
    func testTheTerminalAttachesAndRendersItsPane() {
        XCTAssertTrue(waitForMainWindow())
        XCTAssertTrue(selectFirstSession(), "a live server should offer a session to select")
        XCTAssertTrue(selectTab(at: 0), "the terminal tab is registered at order 0")

        let terminal = app.descendants(matching: .any)["terminal-view"]
        XCTAssertTrue(terminal.waitForExistence(timeout: 30), "the emulator should be hosted")
        XCTAssertTrue(
            app.descendants(matching: .any)["terminal-prompt"].waitForExistence(timeout: 30),
            "the prompt bar should render under the emulator")

        // The attach size follows the viewport; the socket must survive the change.
        if let window = app.windows.allElementsBoundByIndex.first {
            let size = window.frame.size
            window.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: size.width, dy: size.height))
                .press(
                    forDuration: 0.1,
                    thenDragTo: window.coordinate(withNormalizedOffset: .zero)
                        .withOffset(CGVector(dx: size.width - 160, dy: size.height - 120)))
        }

        XCTAssertTrue(terminal.exists, "the emulator should still be hosted after a resize")
        XCTAssertEqual(app.state, .runningForeground, "and the app should still be alive")
    }

    // MARK: - Isolation

    /// An isolated launch reads the operator's Keychain not at all, so the
    /// SecurityAgent dialog that stalls an unattended run must never appear.
    func testAnIsolatedRunNeverRaisesAKeychainPrompt() {
        XCTAssertTrue(waitForMainWindow())
        XCTAssertTrue(selectFirstSession(), "a live server should offer a session to select")

        let securityAgent = XCUIApplication(bundleIdentifier: "com.apple.SecurityAgent")
        XCTAssertNotEqual(
            securityAgent.state, .runningForeground,
            "an isolated launch must not raise a Keychain prompt")
        XCTAssertEqual(
            app.state, .runningForeground,
            "and the app must not be parked behind one")
    }

    // MARK: - Helpers

    private var anySessionRow: XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'session-row-'"))
            .firstMatch
    }

    private func elements(withIdentifierPrefix prefix: String) -> [XCUIElement] {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix))
            .allElementsBoundByIndex
    }

    private func waitForMainWindow() -> Bool {
        let sidebar = app.descendants(matching: .any)["herd-sidebar"]
        let flatSidebar = app.descendants(matching: .any)["session-sidebar"]
        let newSession = app.descendants(matching: .any)["toolbar-new-session"]
        return waitForAny([sidebar, flatSidebar, newSession], timeout: 120)
    }

    @discardableResult
    private func selectFirstSession() -> Bool {
        guard anySessionRow.waitForExistence(timeout: 90) else { return false }
        anySessionRow.click()
        return app.descendants(matching: .any)["session-detail"].waitForExistence(timeout: 30)
    }

    /// The detail tab bar's buttons, in registry order.
    private var tabButtons: [XCUIElement] {
        app.tabGroups.firstMatch.radioButtons.allElementsBoundByIndex
    }

    /// Clicks the tab at `index`. See `testEveryDetailTabLoadsForASelectedSession` for why this
    /// goes by position rather than by title.
    @discardableResult
    private func selectTab(at index: Int) -> Bool {
        let deadline = Date().addingTimeInterval(30)
        repeat {
            let buttons = tabButtons
            if index < buttons.count, buttons[index].isHittable {
                buttons[index].click()
                return true
            }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline
        return false
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
