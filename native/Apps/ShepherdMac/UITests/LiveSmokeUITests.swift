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
/// No keystrokes are sent into a live PTY; the terminal test only attaches and resizes.
///
/// Skipped wholesale — and so silent in CI, which has no server — unless
/// `SHEPHERD_LIVE_BASE_URL` and `SHEPHERD_LIVE_PASSWORD` are both set:
///
///     TEST_RUNNER_SHEPHERD_LIVE_BASE_URL=https://…:7330 \
///     TEST_RUNNER_SHEPHERD_LIVE_PASSWORD=… \
///     TEST_RUNNER_SHEPHERD_REVOKE_ON_EXIT=1 \
///       native/scripts/test-app.sh -only-testing:ShepherdUITests
@MainActor
final class LiveSmokeUITests: XCTestCase {
    private let harness = IsolatedUITestHarness()
    private var app: XCUIApplication { harness.application }

    override func setUp() async throws {
        continueAfterFailure = false
        guard let baseURL = LiveUITestEnvironment.baseURL,
            let password = LiveUITestEnvironment.password
        else {
            throw XCTSkip(
                "set SHEPHERD_LIVE_BASE_URL and SHEPHERD_LIVE_PASSWORD (or their "
                    + "TEST_RUNNER_-prefixed spellings) to run the live UI smoke test")
        }

        harness.launch(liveEnvironment: [
            "SHEPHERD_LIVE_BASE_URL": baseURL,
            "SHEPHERD_LIVE_PASSWORD": password,
        ])
    }

    override func tearDown() async throws {
        // XCTest failures must not abort the token-revoking Quit path.
        continueAfterFailure = true
        defer { harness.shutdown() }
        if harness.isRunning { assertReadOnlyAudit() }
    }

    /// Production entry point; all reads hit the configured server. Never press the CTA.
    func testSidebarPlusOpensComposerAndPrefillsALiveIssue() {
        XCTAssertTrue(waitForMainWindow())
        app.buttons["toolbar-new-session"].click()
        let composer = app.descendants(matching: .any).matching(identifier: "compose.sheet").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "S11 must replace the fallback form")
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "compose.issue."))
        // Some configured repositories intentionally have no forge/issues. Select a real listing.
        if !rows.firstMatch.waitForExistence(timeout: 20) {
            app.buttons["compose.repo"].click()
            let options = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "compose.repo.option."))
            let count = options.count
            app.typeKey(.escape, modifierFlags: [])
            for index in 0..<count {
                app.buttons["compose.repo"].click()
                app.buttons["compose.repo.option.\(index)"].click()
                if rows.firstMatch.waitForExistence(timeout: 12) { break }
            }
        }
        XCTAssertTrue(rows.firstMatch.exists, "a live repository must list a real issue")
        let issueNumber = rows.firstMatch.identifier.replacingOccurrences(of: "compose.issue.", with: "")
        rows.firstMatch.click()
        let prompt = app.textViews["compose.prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 10))
        let prefilled = (prompt.value as? String ?? "").contains("#" + issueNumber)
        XCTAssertTrue(prefilled, "selecting the real issue must prefill its number in the draft")
        for id in ["compose.engine", "compose.model", "compose.effort", "compose.capacity"] {
            XCTAssertTrue(app.descendants(matching: .any).matching(identifier: id).firstMatch.waitForExistence(timeout: 15), "\(id) must render")
        }
        XCTAssertTrue(app.buttons["compose.submit"].exists || app.buttons["compose.hold"].exists)
        assertReadOnlyAudit()
        app.typeKey(.escape, modifierFlags: [])
    }

    private func assertReadOnlyAudit() {
        let audit = app.staticTexts.matching(identifier: "live-request-audit").firstMatch
        XCTAssertTrue(audit.waitForExistence(timeout: 5))
        // macOS static text can expose its content as AXValue instead of AXLabel.
        // Parse the entire summary so missing/empty accessibility text cannot pass.
        let summaries = [audit.label, audit.value as? String ?? ""]
        let pattern = /^Live audit: ([0-9]+) reads; ([0-9]+) rejected$/
        guard let match = summaries.compactMap({ $0.wholeMatch(of: pattern) }).first,
              let reads = Int(match.1), let rejected = Int(match.2) else {
            XCTFail("live audit must expose readable request counts")
            return
        }
        XCTAssertEqual(rejected, 0, "live smoke must attempt zero non-GET or branch-status requests; no spawn")
        XCTAssertGreaterThan(reads, 0, "live smoke must actually read the server")
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

        // Deliberately no assertion on `herd-group-<stage>`. That identifier is on the group
        // *header*, and `HerdStage.active` returns `nil` from `headingKey()` on purpose — the
        // active group renders headerless, exactly as the web does. A herd whose sessions are
        // all active therefore renders perfectly and carries no group identifier at all. The
        // sidebar, the tallies and the rows above are what prove it rendered.

        // The repo chip rail is derived from the sessions themselves, so it is
        // only meaningful once the herd spans more than one repo.
        let chips = elements(withIdentifierPrefix: "repo-chip-")
        if chips.count > 0 {
            XCTAssertGreaterThanOrEqual(
                chips.count, 1, "a herd spanning repos should offer at least one repo chip")
        }
    }

    /// Navigation only: selecting these lenses issues snapshot reads, never queue commands.
    func testQueueLensesRenderTheirRegisteredPanels() {
        XCTAssertTrue(waitForMainWindow())
        for (lens, panel) in [("next", "queues-upnext-panel"), ("owed", "queues-owed-panel"),
                              ("done", "queues-done-panel")] {
            let button = app.buttons["herd-lens-\(lens)"]
            XCTAssertTrue(button.waitForExistence(timeout: 15))
            XCTAssertTrue(button.isEnabled)
            button.click()
            XCTAssertTrue(button.isSelected, "the complete lens button frame must be clickable")
            XCTAssertTrue(app.descendants(matching: .any)[panel].waitForExistence(timeout: 30))
        }
        app.buttons["herd-lens-all"].click()
        XCTAssertTrue(anySessionRow.waitForExistence(timeout: 30))
    }

    // MARK: - S1 + S2: the detail tabs

    /// Every registered tab renders its own body and none of them lands on the error state.
    /// Also covers the tab bar itself: with only the built-in prompt tab registered
    /// `DetailTabRegistry.layout` is `.single` and there would be no tab to click at all.
    ///
    /// Tabs are **clicked** by position, because SwiftUI's `TabView` becomes an `NSTabView` whose
    /// items carry no accessibility name on this toolchain — verified against the live window —
    /// so the registry's own sort order (terminal 0, activity 10, diff 20, files 30, git 40,
    /// prompt 1 000) is the only handle the tab BAR offers. What each click landed on is checked
    /// by the body's own `detail-tab-<id>` identifier, which every stream tab now carries: the
    /// pairing below is therefore also the order assertion, and a stream that registers a tab out
    /// of order fails this test rather than silently reshuffling the operator's tab bar.
    func testEveryDetailTabLoadsForASelectedSession() {
        XCTAssertTrue(waitForMainWindow())
        XCTAssertTrue(selectFirstSession(), "a live server should offer a session to select")

        XCTAssertEqual(
            tabButtons.count, 8,
            "terminal, activity, diff, files, git, plan, merge and the built-in prompt tab should all be registered")

        for (index, identifier) in [
            (0, "detail-tab-terminal"),
            (1, "detail-tab-activity"),
            (2, "detail-tab-diff"),
            (3, "detail-tab-files"),
            (4, "detail-tab-git"),
            (5, "detail-tab-plan"),
        ] {
            XCTAssertTrue(selectTab(at: index), "tab \(index) should be in the tab bar")
            let body = app.descendants(matching: .any)[identifier]
            XCTAssertTrue(
                body.waitForExistence(timeout: 30), "\(identifier) should render its own body")
            // Give the feed a bounded chance to answer before judging it, then look for the
            // error state *inside this tab's own body*.
            waitForBodyToResolve(body, timeout: 30)
            XCTAssertFalse(
                body.descendants(matching: .any)["detail-state-error"].exists,
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
        // Clicking still goes by position — the tab bar's buttons carry no accessibility name —
        // but what the click landed on is checked by the tab body's own identifier rather than by
        // trusting the registry's sort order a second time.
        XCTAssertTrue(selectTab(at: 0), "the terminal tab is registered at order 0")

        let pane = app.descendants(matching: .any)["detail-tab-terminal"]
        XCTAssertTrue(
            pane.waitForExistence(timeout: 30), "the terminal tab should render its own body")

        let terminal = pane.descendants(matching: .any)["terminal-view"]
        XCTAssertTrue(terminal.waitForExistence(timeout: 30), "the emulator should be hosted")
        XCTAssertEqual(pane.descendants(matching: .any).matching(identifier: "terminal-view").count, 1)
        XCTAssertTrue([XCUIElement.ElementType.group, .other].contains(terminal.elementType),
            "the emulator must be a non-editable container (group on current macOS, other on older SDKs)")
        XCTAssertTrue(
            pane.descendants(matching: .any)["terminal-prompt"].waitForExistence(timeout: 30),
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
        // Resizing can leave another window frontmost on a shared desktop.
        // Liveness does not require stealing focus back from the operator.
        XCTAssertTrue([XCUIApplication.State.runningForeground, .runningBackground].contains(app.state),
            "and the app should still be alive")
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
        let found = waitForAny([sidebar, flatSidebar, newSession], timeout: 120)
        if !found {
            XCTFail("live launch has \(app.windows.count) windows; welcome=\(app.descendants(matching: .any)["welcome-local-card"].exists); login=\(app.descendants(matching: .any)["login-password"].exists)")
        }
        return found
    }

    @discardableResult
    private func selectFirstSession() -> Bool {
        guard anySessionRow.waitForExistence(timeout: 90) else { return false }
        anySessionRow.click()
        return app.descendants(matching: .any)["session-detail"].waitForExistence(timeout: 30)
    }

    /// Current macOS exposes AX tabs as `.tab`; older toolchains used radio buttons.
    /// Keep registry order without depending on unnamed native tab labels.
    private var tabButtons: [XCUIElement] {
        let group = app.tabGroups.firstMatch
        let tabs = group.children(matching: .tab).allElementsBoundByIndex
        return tabs.isEmpty ? group.radioButtons.allElementsBoundByIndex : tabs
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

    /// Waits for one detail tab's body to leave `detail-state-loading`.
    ///
    /// Two things make the naive check — assert the instant the body exists — useless. The body
    /// container appears *before* the feed answers, because `DetailStateView` renders the
    /// spinner inside that same body, so an assertion made there passes before there is
    /// anything to judge. And `TabView` keeps every visited child alive, so an app-wide query
    /// for `detail-state-error` would still see a *previous* tab's failure and pin it on this
    /// one — which is why the caller scopes its query to `body` and this helper waits on
    /// `body`'s own spinner.
    ///
    /// Returns whether the body resolved (content, `detail-state-empty` or `detail-state-error`)
    /// within `timeout`. A still-loading body at the deadline is **not** a failure: it is the
    /// error state that must not appear, and it cannot appear while the spinner is up. The
    /// caller asserts that separately, so the result is discardable.
    @discardableResult
    private func waitForBodyToResolve(_ body: XCUIElement, timeout: TimeInterval) -> Bool {
        let loading = body.descendants(matching: .any)["detail-state-loading"]
        let resolved = [
            body.descendants(matching: .any)["detail-state-empty"],
            body.descendants(matching: .any)["detail-state-error"],
        ]
        // Let the body lay its children out first: a container whose subtree has not been
        // built yet has no spinner either, and would read as "resolved" the moment it appeared.
        let armed = Date().addingTimeInterval(2)
        while Date() < armed, !loading.exists, !resolved.contains(where: { $0.exists }) {
            Thread.sleep(forTimeInterval: 0.1)
        }
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if !loading.exists { return true }
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
