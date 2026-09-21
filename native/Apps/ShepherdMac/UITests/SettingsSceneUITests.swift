import XCTest

@MainActor
final class SettingsSceneUITests: XCTestCase {
    private let harness = IsolatedUITestHarness()
    private var app: XCUIApplication { harness.application }

    override func setUp() async throws {
        continueAfterFailure = false
        harness.launch()
        XCTAssertTrue(app.descendants(matching: .any)["welcome-local-card"].waitForExistence(timeout: 15))
    }

    override func tearDown() async throws {
        harness.shutdown()
    }

    func testSettingsUsesOneWindowAndRetiresLegacyMenu() {
        for _ in 0..<3 { app.typeKey(",", modifierFlags: .command) }
        let panes = app.descendants(matching: .any)["settings-panes"]
        XCTAssertTrue(panes.waitForExistence(timeout: 5))
        XCTAssertEqual(app.windows.count, 2, "one main window and one Settings window")
        for title in ["General", "Notifications", "Workspace", "Coding CLIs", "Access", "Diagnose"] {
            XCTAssertTrue(app.toolbars.buttons[title].exists, "pane registered before activation: \(title)")
        }
        app.menuBars.menuBarItems["Shepherd"].click()
        XCTAssertFalse(app.menuItems["Notifications…"].exists)
        app.typeKey(.escape, modifierFlags: [])
    }

    func testDisconnectedNotificationsExplainsNextStep() {
        app.typeKey(",", modifierFlags: .command)
        XCTAssertTrue(app.descendants(matching: .any)["settings-panes"].waitForExistence(timeout: 5))
        app.toolbars.buttons["Notifications"].click()
        XCTAssertTrue(app.staticTexts["settings-unavailable-title"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["settings-unavailable-title"].value as? String, "No connection selected")
        XCTAssertTrue(app.staticTexts["settings-unavailable-summary"].exists)
        let action = app.buttons["settings-unavailable-action"]
        XCTAssertTrue(action.exists)
        let window = app.windows.containing(.any, identifier: "settings-panes").firstMatch
        let screenshot = XCTAttachment(screenshot: window.screenshot())
        screenshot.name = "Settings-disconnected-notifications"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        action.click()
        let remoteAddress = app.textFields["welcome-remote-url"]
        XCTAssertTrue(remoteAddress.waitForExistence(timeout: 5))
        remoteAddress.click()
        remoteAddress.typeText("https://settings.example.invalid")
        XCTAssertEqual(remoteAddress.value as? String, "https://settings.example.invalid")
    }

    func testPaletteSearchReturnEscapeAndDisabledCommand() {
        app.typeKey("k", modifierFlags: .command)
        let search = app.textFields["Search commands"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.typeText("Refresh diagnostics")
        XCTAssertFalse(app.buttons["Refresh diagnostics"].isEnabled)
        app.typeKey(.return, modifierFlags: [])
        XCTAssertTrue(search.exists, "disabled commands cannot execute or dismiss the palette")
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(search.waitForNonExistence(timeout: 5))
        app.typeKey("k", modifierFlags: .command)
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.typeText("Settings")
        app.typeKey(.return, modifierFlags: [])
        XCTAssertTrue(app.descendants(matching: .any)["settings-panes"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.windows.count, 2)
    }
}
