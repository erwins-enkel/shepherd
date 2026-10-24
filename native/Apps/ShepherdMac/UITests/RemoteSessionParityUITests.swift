import XCTest
import Synchronization

/// Runs only against test/fixtures/remote-session-parity-ui-server.ts, never a saved profile.
@MainActor final class RemoteSessionParityUITests: XCTestCase {
    private let harness = IsolatedUITestHarness()
    override func tearDown() { harness.shutdown() }

    func testRemoteControlsSteeringAndReconnect() throws {
        let env = ProcessInfo.processInfo.environment
        guard let file = env["SHEPHERD_REMOTE_FIXTURE_FILE"] ?? env["TEST_RUNNER_SHEPHERD_REMOTE_FIXTURE_FILE"] else {
            throw XCTSkip("Requires the isolated remote-session-parity UI fixture")
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: file)))
        XCTAssertEqual(URL(string: fixture.baseURL)?.host, "127.0.0.1")
        XCTAssertEqual(URL(string: fixture.controlURL)?.host, "127.0.0.1")
        continueAfterFailure = false
        harness.launch()
        let app = harness.application
        let address = app.textFields["welcome-remote-url"]
        XCTAssertTrue(address.waitForExistence(timeout: 15))
        address.click(); address.typeText(fixture.baseURL)
        app.buttons["welcome-remote-connect"].click()
        let password = app.secureTextFields["login-password"]
        XCTAssertTrue(password.waitForExistence(timeout: 10))
        password.click(); password.typeText("operator-password\n")
        let remoteMenu = app.descendants(matching: .any)["session-menu-\(fixture.remoteId)"]
        XCTAssertTrue(remoteMenu.waitForExistence(timeout: 30))
        let localMenu = app.descendants(matching: .any)["session-menu-\(fixture.localId)"]
        XCTAssertTrue(localMenu.exists)
        // Select another session first. A context action must select its own card.
        app.staticTexts["mo-task"].firstMatch.click()
        XCTAssertTrue(app.tabGroups.firstMatch.waitForExistence(timeout: 10))
        let localScreenshot = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        localScreenshot.name = "Local session controls"; localScreenshot.lifetime = .keepAlways
        add(localScreenshot)
        app.staticTexts["mac-task"].firstMatch.rightClick()
        app.menuItems["context-rename"].click()
        let name = app.textFields["rename-field"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.click(); name.typeKey("a", modifierFlags: .command); name.typeText("mac-renamed")
        app.buttons["rename-submit"].click()
        XCTAssertTrue(app.staticTexts["mac-renamed"].firstMatch.waitForExistence(timeout: 10))

        let group = app.tabGroups.firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 5))
        var tabs = group.children(matching: .tab).allElementsBoundByIndex
        if tabs.isEmpty { tabs = group.radioButtons.allElementsBoundByIndex }
        XCTAssertEqual(tabs.count, 8)
        for (index, id) in ["terminal", "activity", "diff", "files", "git", "plan", "merge", "prompt"].enumerated() {
            tabs[index].click()
            XCTAssertTrue(app.descendants(matching: .any)["detail-tab-\(id)"].firstMatch.waitForExistence(timeout: 10), id)
        }
        tabs[0].click()
        let chip = app.buttons["terminal-steer-mo-steer"]
        XCTAssertTrue(chip.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["terminal-steer-mac-steer"].exists)
        XCTAssertTrue(chip.isEnabled)
        XCTAssertTrue(app.buttons["toolbar-interrupt"].isEnabled)
        XCTAssertTrue(app.buttons["toolbar-archive"].isEnabled)
        let remoteScreenshot = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        remoteScreenshot.name = "Remote session controls"; remoteScreenshot.lifetime = .keepAlways
        add(remoteScreenshot)
        chip.click()
        try waitForAudit(fixture) { $0.filter { $0.action == "reply" }.count == 1 }
        app.typeKey("1", modifierFlags: .command)
        try waitForAudit(fixture) { $0.filter { $0.action == "reply" }.count == 2 }
        let before = try state(fixture).audit.filter { $0.action == "attach" }.count
        try control(fixture, "disconnect")
        XCTAssertTrue(app.descendants(matching: .any)["remote-detail-disconnected"].waitForExistence(timeout: 10))
        XCTAssertFalse(chip.isEnabled)
        XCTAssertTrue(remoteMenu.exists)
        app.buttons["terminal-steers-all"].click()
        let offlineClose = app.buttons["Decommission · hold"]
        XCTAssertTrue(offlineClose.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertFalse(offlineClose.isEnabled)
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(app.buttons["terminal-steers-edit"].isEnabled)
        app.buttons["terminal-steers-edit"].click()
        let text = app.textViews["Steer prompt text"]
        XCTAssertTrue(text.waitForExistence(timeout: 5))
        text.click(); text.typeKey("a", modifierFlags: .command); text.typeText("edited on Mo")
        app.buttons["Save"].click()
        XCTAssertTrue(text.waitForNonExistence(timeout: 5))
        let saved = try state(fixture).steers
        XCTAssertEqual(saved["mo"]?.first?.text, "edited on Mo")
        XCTAssertEqual(saved["mac"]?.first?.text, "mac instruction")
        try control(fixture, "reconnect")
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: chip)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 10), .completed)
        try waitForAudit(fixture) { $0.filter { $0.action == "attach" }.count > before }

        // Closing preserves the real confirmation, including cancellation.
        remoteMenu.click(); app.menuItems["context-decommission"].click()
        XCTAssertTrue(app.descendants(matching: .any)["compose.action.close"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].click()
        XCTAssertTrue(remoteMenu.exists)
        remoteMenu.click(); app.menuItems["context-decommission"].click()
        let close = app.buttons["Close session only"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        close.click()
        try waitForAudit(fixture) { $0.contains { $0.action == "archive" } }
        let final = try state(fixture).audit
        let mutations = final.filter { ["reply", "rename", "archive"].contains($0.action) }
        XCTAssertTrue(mutations.allSatisfy { $0.machine == "mac" && $0.id == fixture.remoteId })
        XCTAssertEqual(mutations.filter { $0.action == "reply" }.compactMap(\.text), ["mo instruction", "mo instruction"])
        XCTAssertFalse(remoteMenu.exists)
        XCTAssertTrue(localMenu.exists)
    }

    private struct Fixture: Decodable { let baseURL, controlURL, localId, remoteId: String }
    private struct Audit: Decodable { let machine, action, id: String; let text: String? }
    private struct Steer: Decodable { let text: String }
    private struct State: Decodable { let audit: [Audit]; let steers: [String: [Steer]] }
    private func request(_ request: URLRequest) throws -> (Data, URLResponse) {
        let completed = expectation(description: "Fixture request")
        let result = Mutex<Result<(Data, URLResponse), any Error>?>(nil)
        URLSession.shared.dataTask(with: request) { data, response, error in
            result.withLock { $0 = error.map { .failure($0) } ?? .success((data!, response!)) }
            completed.fulfill()
        }.resume()
        wait(for: [completed], timeout: 10)
        return try result.withLock { try XCTUnwrap($0).get() }
    }
    private func state(_ fixture: Fixture) throws -> State {
        let (data, _) = try request(URLRequest(url: URL(string: fixture.controlURL + "/state")!))
        return try JSONDecoder().decode(State.self, from: data)
    }
    private func control(_ fixture: Fixture, _ action: String) throws {
        var request = URLRequest(url: URL(string: fixture.controlURL + "/" + action)!)
        request.httpMethod = "POST"
        let (_, response) = try self.request(request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }
    private func waitForAudit(_ fixture: Fixture, _ predicate: ([Audit]) -> Bool) throws {
        for _ in 0..<100 {
            if predicate(try state(fixture).audit) { return }
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTFail("Fixture did not receive the expected action")
    }
}
