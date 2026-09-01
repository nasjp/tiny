import XCTest

/// A multi-question AskUserQuestion is a carousel: choosing an answer slides the next question in
/// from the right. This test watches the actual frames — an instant swap and a slide are
/// indistinguishable once the animation is over, so the evidence has to be caught mid-flight.
final class QuestionCarouselUITests: XCTestCase {
    private let first = "Which approach should I take?"
    private let second = "Where should it ship?"

    func testChoosingAnAnswerSlidesTheNextQuestionIn() {
        let app = XCUIApplication()
        app.launchArguments = ["-DemoMode"]
        app.launch()
        XCTAssertTrue(app.navigationBars["Sessions (Demo)"].waitForExistence(timeout: 10))
        app.cells.firstMatch.tap()
        let chatInput = app.descendants(matching: .any)["chatInput"]
        XCTAssertTrue(chatInput.waitForExistence(timeout: 5))
        chatInput.tap()
        chatInput.typeText("three questions please")
        app.buttons["sendButton"].tap()

        let option = app.buttons["questionOption0_0"]
        XCTAssertTrue(option.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts[first].exists)
        option.tap()

        // Sample the two questions' positions while the carousel should be moving. A slide shows
        // both at once, with the incoming one still to the right of its resting place
        var sawBothOnScreen = false
        var sawIncomingOffToTheRight = false
        let width = app.frame.width
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            let outgoing = app.staticTexts[first]
            let incoming = app.staticTexts[second]
            let incomingExists = incoming.exists
            if incomingExists {
                let x = incoming.frame.minX
                if outgoing.exists { sawBothOnScreen = true }
                if x > width * 0.25 { sawIncomingOffToTheRight = true }
                if !outgoing.exists && x < width * 0.25 { break }   // settled on the second question
            }
        }
        XCTAssertTrue(app.staticTexts[second].waitForExistence(timeout: 3), "the second question must arrive")
        XCTAssertTrue(sawBothOnScreen || sawIncomingOffToTheRight,
                      "the next question appeared instantly: no frame showed it travelling in")
    }
}
