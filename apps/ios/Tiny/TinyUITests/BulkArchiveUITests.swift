import XCTest

/// Multi-select on the session list and the Archived screen, exercised on the demo backend
final class BulkArchiveUITests: XCTestCase {
    private func wait(_ timeout: TimeInterval = 5, until condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return condition()
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-DemoMode"]
        app.launch()
        XCTAssertTrue(app.navigationBars["Sessions (Demo)"].waitForExistence(timeout: 10))
        XCTAssertTrue(wait { app.cells.count == 3 }, "the demo starts with three sessions")
        return app
    }

    func testSelectingSeveralSessionsArchivesAndRestoresThemTogether() {
        let app = launch()

        app.buttons["selectButton"].tap()
        XCTAssertTrue(app.buttons["selectAllButton"].waitForExistence(timeout: 3))
        app.buttons["selectAllButton"].tap()
        XCTAssertEqual(app.buttons["bulkArchiveButton"].label, "Archive 3 Sessions")
        app.cells.element(boundBy: 0).tap()   // untick the first row
        XCTAssertEqual(app.buttons["bulkArchiveButton"].label, "Archive 2 Sessions")
        app.buttons["bulkArchiveButton"].tap()
        XCTAssertTrue(wait { app.cells.count == 1 }, "two rows should leave the list")
        XCTAssertTrue(app.buttons["newSessionButton"].waitForExistence(timeout: 3), "selection mode should end")

        app.buttons["archivedButton"].tap()
        XCTAssertTrue(app.navigationBars["Archived"].waitForExistence(timeout: 5))
        XCTAssertTrue(wait { app.cells.count == 2 })
        app.buttons["selectButton"].tap()
        XCTAssertTrue(app.buttons["selectAllButton"].waitForExistence(timeout: 3))
        app.buttons["selectAllButton"].tap()
        XCTAssertEqual(app.buttons["bulkUnarchiveButton"].label, "Unarchive 2 Sessions")
        app.buttons["bulkUnarchiveButton"].tap()
        XCTAssertTrue(app.staticTexts["No archived sessions"].waitForExistence(timeout: 5))
    }

    func testLongPressStartsSelectionWithThatRow() {
        let app = launch()
        app.cells.element(boundBy: 1).press(forDuration: 1.0)
        // The toolbar's own Select button carries the same label; the menu item is the one without the identifier
        let select = app.buttons.matching(
            NSPredicate(format: "label == 'Select' AND identifier != 'selectButton'")).firstMatch
        XCTAssertTrue(select.waitForExistence(timeout: 3), "the context menu should offer Select")
        select.tap()
        XCTAssertTrue(app.buttons["bulkArchiveButton"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.buttons["bulkArchiveButton"].label, "Archive 1 Session")
        // Done leaves the mode with nothing archived
        app.buttons["doneSelectingButton"].tap()
        XCTAssertTrue(app.buttons["newSessionButton"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.cells.count, 3)
    }
}
