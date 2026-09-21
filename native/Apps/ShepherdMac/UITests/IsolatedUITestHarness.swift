import XCTest

/// Owns the only launch path and relinquishes query access BEFORE requesting Quit.
/// Never attach a fresh automation handle to a terminated app: activation can launch it.
@MainActor
final class IsolatedUITestHarness {
    private var running: XCUIApplication?
    private var cleanupDirectory: URL?

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
        if liveEnvironment["SHEPHERD_LIVE_PASSWORD"] != nil {
            do {
                let directory = try makeCleanupDirectory()
                cleanupDirectory = directory
                app.launchEnvironment["SHEPHERD_CLEANUP_STATUS_PATH"] = directory.appendingPathComponent("status.json").path
            } catch {
                XCTFail("Could not create private cleanup evidence directory")
                return
            }
        }
        let isolation = app.launchArguments.firstIndex(of: "-ShepherdIsolated")
        precondition(isolation.map { app.launchArguments[$0 + 1] == "1" } == true,
            "every UI launch must pass isolation arguments")
        running = app
        app.launch()
    }

    /// The test runner's temporary directory can be protected by user-data TCC policy when this
    /// path is inherited by the separately launched app. Use the system's explicit shared temp
    /// root, with a per-launch private directory, instead.
    private func makeCleanupDirectory() throws -> URL {
        let fileManager = FileManager.default
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
        let rootValues = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard root.standardizedFileURL.path == "/private/tmp",
              rootValues.isDirectory == true,
              rootValues.isSymbolicLink != true
        else {
            throw CocoaError(.fileNoSuchFile)
        }

        let directory = root.appendingPathComponent("shepherd-ui-cleanup-\(UUID())", isDirectory: true)
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        let directoryValues = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard directoryValues.isDirectory == true, directoryValues.isSymbolicLink != true else {
            try? fileManager.removeItem(at: directory)
            throw CocoaError(.fileNoSuchFile)
        }
        return directory
    }

    func shutdown() {
        guard let app = running else { return }
        running = nil
        // From this point onward only process-state APIs may be used after the Quit keystroke.
        // No element queries, screenshots, new application handles, or activation here.
        defer {
            if let cleanupDirectory { try? FileManager.default.removeItem(at: cleanupDirectory) }
            cleanupDirectory = nil
        }
        if app.state != .notRunning {
            app.typeKey("q", modifierFlags: .command)
            let quit = app.wait(for: .notRunning, timeout: 10)
            if !quit { app.terminate() }
            XCTAssertTrue(quit, "Isolated app must finish bounded graceful Quit")
        }
        if let cleanupDirectory {
            // Read only the fixed schema, never print file contents or attach credentials.
            let data = try? Data(contentsOf: cleanupDirectory.appendingPathComponent("status.json"))
            let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
            let verified = object?["owned"] as? Int == 1 && object?["verified"] as? Int == 1
                && object?["error"] == nil
            XCTAssertTrue(verified, "Isolated UI token cleanup must be 401 verified before Quit completes")
            if verified { print("isolated UI launch: owned=1 verified=1 (401 verified)") }
        }
    }
}
