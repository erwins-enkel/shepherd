import Foundation
import XCTest

@MainActor
final class ShepherdIOSLiveCleanupUITests: XCTestCase {
    private let app = XCUIApplication()
    private var values: [String: String] = [:]
    private var launched = false

    override func setUpWithError() throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        for key in ["SHEPHERD_LIVE_BASE_URL", "SHEPHERD_LIVE_PASSWORD", "SHEPHERD_IOS_RUN_ID",
                    "SHEPHERD_IOS_CLEANUP_STATUS_PATH", "SHEPHERD_IOS_TOKEN_HANDOFF_PATH"] {
            guard let value = environment[key] ?? environment["TEST_RUNNER_" + key], !value.isEmpty else {
                throw NSError(domain: "ShepherdIOSLiveAcceptance", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Use the isolated live-smoke harness"])
            }
            values[key] = value
        }
        app.launchArguments = ["-ShepherdIsolated", "1"]
        app.launchEnvironment = values.merging(["SHEPHERD_ISOLATED": "1"]) { _, new in new }
        app.launch()
        launched = true
    }

    func testLiveSessionActivityAndReadAudit() {
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "session-row-")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "A live session is required for detail coverage")
        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["session-detail"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any)["detail-activity-list"].waitForExistence(timeout: 15))
        let audit = app.staticTexts["live-request-audit"]
        XCTAssertTrue(audit.waitForExistence(timeout: 5))
        XCTAssertNotNil(audit.label.range(of: #"^Live audit: [1-9][0-9]* reads; 0 rejected$"#, options: .regularExpression))
        for identifier in ["terminal-input", "compose.submit", "archive-session", "interrupt-session", "merge-submit"] {
            XCTAssertFalse(app.buttons[identifier].exists)
        }
    }

    override func tearDown() async throws {
        continueAfterFailure = true
        guard launched else { return }
        let cleanup = app.buttons["live-cleanup"]
        if cleanup.waitForExistence(timeout: 5) { cleanup.tap() }
        let status = app.staticTexts["live-cleanup-status"]
        let returned = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "revocation_returned"), object: status)
        _ = await fulfillment(of: [returned], timeout: 15)
        // Verify the token before terminating the app; the outer harness repeats this
        // independently and owns recovery if assertions or cancellation interrupt us.
        var verified = false
        if let path = values["SHEPHERD_IOS_TOKEN_HANDOFF_PATH"],
           let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
           let handoff = try? JSONDecoder().decode(OwnedToken.self, from: data),
           handoff.runID == values["SHEPHERD_IOS_RUN_ID"],
           handoff.baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == values["SHEPHERD_LIVE_BASE_URL"]?.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
           let base = URL(string: handoff.baseURL) {
            var request = URLRequest(url: base.appendingPathComponent("api/sessions"))
            request.setValue("Bearer " + handoff.token, forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 5
            let session = URLSession(configuration: .ephemeral, delegate: RejectRedirects(), delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            for _ in 0..<3 {
                if let (_, response) = try? await session.data(for: request),
                   (response as? HTTPURLResponse)?.statusCode == 401 { verified = true; break }
            }
        }
        XCTAssertTrue(verified, "The owned token must return HTTP 401 before termination")
        if verified { app.terminate() }
    }

    private struct OwnedToken: Decodable {
        let runID: String
        let tokenID: String
        let token: String
        let baseURL: String
    }
}

private final class RejectRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
