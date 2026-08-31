import XCTest

final class SmokeUITests: XCTestCase {
    func testDemoModeWalkthrough() {
        let app = XCUIApplication()
        app.launchArguments = ["-DemoMode"]
        app.launch()

        // Demo mode starts at the session list
        XCTAssertTrue(app.navigationBars["Sessions (Demo)"].waitForExistence(timeout: 10))

        // Open the demo session
        app.cells.firstMatch.tap()
        let chatInput = app.descendants(matching: .any)["chatInput"]
        XCTAssertTrue(chatInput.waitForExistence(timeout: 5))

        // Send a turn → a response streams in
        chatInput.tap()
        chatInput.typeText("hello")
        app.buttons["sendButton"].tap()
        XCTAssertTrue(app.staticTexts
            .containing(NSPredicate(format: "label CONTAINS 'Demo'")).firstMatch
            .waitForExistence(timeout: 10))

        // Permission flow: "build" raises permission_requested → allow
        chatInput.tap()
        chatInput.typeText("build it")
        app.buttons["sendButton"].tap()
        XCTAssertTrue(app.buttons["allowButton"].waitForExistence(timeout: 10))
        app.buttons["allowButton"].tap()
        // The Done label reads as DONE due to textCase(.uppercase)
        XCTAssertTrue(app.staticTexts["DONE"].waitForExistence(timeout: 10))
    }
}
