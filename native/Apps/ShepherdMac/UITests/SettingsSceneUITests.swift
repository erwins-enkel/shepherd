import XCTest

final class SettingsSceneUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES", "-NSQuitAlwaysKeepsWindows", "NO",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-ShepherdIsolated", "1",
        ]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["welcome-local-card"].waitForExistence(timeout: 15))
    }

    override func tearDownWithError() throws {
        app.terminate()
        app = nil
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
