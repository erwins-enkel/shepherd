import XCTest

@MainActor
final class ShepherdIOSDuoUITests: XCTestCase {
    func testSelectedDuoSurfaceKeepsConnectionFormAccessible() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let surface = environment["SHEPHERD_IOS_SURFACE"] ?? environment["TEST_RUNNER_SHEPHERD_IOS_SURFACE"],
              ["DuoOuter", "DuoInner"].contains(surface) else {
            throw NSError(domain: "ShepherdIOSDuoAcceptance", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "An explicit Duo surface destination is required"])
        }
        let app = XCUIApplication()
        app.launchArguments = ["-ShepherdIsolated", "1"]
        app.launchEnvironment = ["SHEPHERD_ISOLATED": "1"]
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.buttons["add-server"].waitForExistence(timeout: 10))
        app.buttons["add-server"].tap()
        let address = app.textFields["server-address"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        XCTAssertTrue(address.isHittable)
        address.tap()
        address.typeText("https://example.invalid")
        XCTAssertTrue(app.buttons["connect-server"].isHittable)
    }
}
