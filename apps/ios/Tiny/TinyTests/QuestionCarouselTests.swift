import XCTest
@testable import Tiny

/// The carousel's arithmetic. The slide itself is watched by QuestionCarouselUITests — these pin
/// down where a page rests, how far a drag pulls, and which page a swipe lands on
final class QuestionCarouselTests: XCTestCase {
    private let width: CGFloat = 320

    func testEachPageRestsExactlyOneCardWidthApart() {
        XCTAssertEqual(QuestionCarousel.offset(page: 0, drag: 0, width: width), 0)
        XCTAssertEqual(QuestionCarousel.offset(page: 1, drag: 0, width: width), -320)
        XCTAssertEqual(QuestionCarousel.offset(page: 2, drag: 0, width: width), -640)
        // A drag moves the strip with the finger
        XCTAssertEqual(QuestionCarousel.offset(page: 1, drag: -40, width: width), -360)
    }

    func testDragPastTheEndsPullsAgainstASpring() {
        // In the middle the strip follows the finger one-to-one
        XCTAssertEqual(QuestionCarousel.rubberBanded(-100, page: 1, count: 3, width: width), -100)
        // Before the first question and after the last it gives way only a little
        XCTAssertEqual(QuestionCarousel.rubberBanded(100, page: 0, count: 3, width: width), 35, accuracy: 0.001)
        XCTAssertEqual(QuestionCarousel.rubberBanded(-100, page: 2, count: 3, width: width), -35, accuracy: 0.001)
        // …and dragging back into the deck from an end is normal movement
        XCTAssertEqual(QuestionCarousel.rubberBanded(100, page: 2, count: 3, width: width), 100)
    }

    func testASwipeTurnsThePageOnlyOnceItPassesAQuarterOfTheCard() {
        XCTAssertEqual(QuestionCarousel.target(page: 0, translation: -60, width: width, count: 3), 0, "too short to count")
        XCTAssertEqual(QuestionCarousel.target(page: 0, translation: -90, width: width, count: 3), 1)
        XCTAssertEqual(QuestionCarousel.target(page: 1, translation: 90, width: width, count: 3), 0)
        // The deck does not run off either end
        XCTAssertEqual(QuestionCarousel.target(page: 2, translation: -200, width: width, count: 3), 2)
        XCTAssertEqual(QuestionCarousel.target(page: 0, translation: 200, width: width, count: 3), 0)
    }

    func testAnUnmeasuredCardStillTakesASwipe() {
        // width is 0 until the first layout pass; a 40pt floor keeps the gesture usable
        XCTAssertEqual(QuestionCarousel.target(page: 0, translation: -50, width: 0, count: 2), 1)
        XCTAssertEqual(QuestionCarousel.target(page: 0, translation: -20, width: 0, count: 2), 0)
    }
}
