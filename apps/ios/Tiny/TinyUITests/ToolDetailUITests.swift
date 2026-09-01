import XCTest

/// A tool call opened from the tool sheet shows what it ran and what it printed (demo backend)
final class ToolDetailUITests: XCTestCase {
    func testOpeningAToolRowShowsItsCommandAndOutput() {
        let app = XCUIApplication()
        app.launchArguments = ["-DemoMode"]
        app.launch()
        XCTAssertTrue(app.navigationBars["Sessions (Demo)"].waitForExistence(timeout: 10))
        app.cells.firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chatInput"].waitForExistence(timeout: 5))

        // The demo history has one Bash call, collapsed into "Ran 1 command"
        let summary = app.buttons["Ran 1 command"]
        XCTAssertTrue(summary.waitForExistence(timeout: 5))
        summary.tap()
        let row = app.buttons["toolRow_t1"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()

        XCTAssertTrue(app.navigationBars["Bash"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["npm test"].exists, "the command is shown")
        let output = app.staticTexts["toolOutput"]
        XCTAssertTrue(output.waitForExistence(timeout: 3))
        XCTAssertTrue(output.label.contains("41 passed"), "the output is shown: \(output.label)")
    }
}
