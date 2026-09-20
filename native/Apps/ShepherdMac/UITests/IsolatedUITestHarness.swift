import XCTest

/// Owns the only launch path and relinquishes query access BEFORE requesting Quit.
/// Never attach a fresh automation handle to a terminated app: activation can launch it.
@MainActor
final class IsolatedUITestHarness {
    private var running: XCUIApplication?

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
        let isolation = app.launchArguments.firstIndex(of: "-ShepherdIsolated")
        precondition(isolation.map { app.launchArguments[$0 + 1] == "1" } == true,
            "every UI launch must pass isolation arguments")
        running = app
        app.launch()
    }

    func shutdown() {
        guard let app = running else { return }
        running = nil
        // From this point onward only process-state APIs may be used after the Quit keystroke.
        // No element queries, screenshots, new application handles, or activation here.
        guard app.state != .notRunning else { return }
        app.typeKey("q", modifierFlags: .command)
        if !app.wait(for: .notRunning, timeout: 10) { app.terminate() }
    }
}
