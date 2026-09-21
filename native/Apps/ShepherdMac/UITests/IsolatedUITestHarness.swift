import XCTest

/// Owns the only launch path and relinquishes query access BEFORE requesting Quit.
/// Never attach a fresh automation handle to a terminated app: activation can launch it.
@MainActor
final class IsolatedUITestHarness {
    private var running: XCUIApplication?
    private var expectsCleanup = false

    var isRunning: Bool { running.map { $0.state != .notRunning } ?? false }

    var application: XCUIApplication {
        guard let running, running.state != .notRunning else {
            preconditionFailure("UI queries are forbidden before launch and after shutdown")
        }
        return running
    }

    func launch(liveEnvironment: [String: String] = [:]) {
        precondition(running == nil, "shut down the previous isolated launch first")
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES", "-NSQuitAlwaysKeepsWindows", "NO",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-ShepherdIsolated", "1", "-ShepherdRevokeOnExit", "1",
        ]
        // Empty values explicitly prevent the welcome suite from inheriting live credentials.
        for name in ["SHEPHERD_LIVE_BASE_URL", "SHEPHERD_LIVE_PASSWORD"] {
            app.launchEnvironment[name] = liveEnvironment[name] ?? ""
            app.launchEnvironment["TEST_RUNNER_" + name] = ""
        }
        app.launchEnvironment["SHEPHERD_ISOLATED"] = "1"
        app.launchEnvironment["SHEPHERD_CLEANUP_STATUS_PATH"] = ""
        app.launchEnvironment["TEST_RUNNER_SHEPHERD_CLEANUP_STATUS_PATH"] = ""
        expectsCleanup = liveEnvironment["SHEPHERD_LIVE_BASE_URL"] != nil
            && liveEnvironment["SHEPHERD_LIVE_PASSWORD"] != nil
        app.launchEnvironment["SHEPHERD_UI_CLEANUP_HANDSHAKE"] = expectsCleanup ? "1" : "0"
        app.launchEnvironment["TEST_RUNNER_SHEPHERD_UI_CLEANUP_HANDSHAKE"] = "0"
        let isolation = app.launchArguments.firstIndex(of: "-ShepherdIsolated")
        precondition(isolation.map { app.launchArguments[$0 + 1] == "1" } == true,
            "every UI launch must pass isolation arguments")
        running = app
        app.launch()
    }

    func shutdown() {
        guard let app = running else { return }
        // LiveSmokeUITests has already checked the request audit. The original handle
        // remains usable for cleanup proof, then is relinquished before Quit on every path.
        defer {
            running = nil
            expectsCleanup = false
            // After sending Quit, only process-state APIs are permitted. Never query AX,
            // capture screenshots, attach another handle, or activate a stopped process.
            if app.state != .notRunning {
                app.typeKey("q", modifierFlags: .command)
                let quit = app.wait(for: .notRunning, timeout: 10)
                if !quit { app.terminate() }
                XCTAssertTrue(quit, "Isolated app must finish bounded graceful Quit")
            }
        }
        if expectsCleanup {
            guard app.state != .notRunning else {
                XCTFail("Isolated app exited before its owned-token cleanup could be verified")
                return
            }
            verifyCleanupBeforeQuit(app)
        }
    }

    private func verifyCleanupBeforeQuit(_ app: XCUIApplication) {
        // A scene command reaches the app even when a failed scenario left a sheet open.
        // The command uses the same cached shutdown as Quit, so retries cannot mint or delete twice.
        app.typeKey("k", modifierFlags: [.command, .option, .shift])
        let status = app.staticTexts.matching(identifier: "isolated-cleanup-status").firstMatch
        let completed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true AND label BEGINSWITH %@", "finished "),
            object: status)
        // The cleanup probe may retry GETs; this phase covers its approximately 12.6-second
        // worst network budget separately from the final process Quit guard.
        let terminal = XCTWaiter.wait(for: [completed], timeout: 20) == .completed
        guard terminal else {
            XCTFail("Isolated UI cleanup did not produce a terminal status before Quit")
            return
        }
        let verified = status.label == "finished owned=1 verified=1 error=none"
        XCTAssertTrue(verified, "Isolated UI token cleanup must be 401 verified before Quit")
        if verified { print("isolated UI launch: owned=1 verified=1 (401 verified)") }
    }
}
