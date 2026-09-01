import XCTest
@testable import Tiny

/// The Running row's wording mirrors Claude Code's own status line ("5m 58s · ↓ 16.4k tokens")
final class ActivityFormatTests: XCTestCase {
    func testElapsed() {
        XCTAssertEqual(ActivityFormat.elapsed(0), "0s")
        XCTAssertEqual(ActivityFormat.elapsed(42.9), "42s")
        XCTAssertEqual(ActivityFormat.elapsed(358), "5m 58s")
        XCTAssertEqual(ActivityFormat.elapsed(3720), "1h 02m")
        XCTAssertEqual(ActivityFormat.elapsed(-5), "0s", "a clock skewed into the future must not read negative")
    }

    func testTokens() {
        XCTAssertEqual(ActivityFormat.tokens(980), "980 tokens")
        XCTAssertEqual(ActivityFormat.tokens(16_400), "16.4k tokens")
        XCTAssertEqual(ActivityFormat.tokens(1_260_000), "1.3M tokens")
    }

    func testLineLeavesOutWhatTheServerDoesNotKnow() {
        let since = Date(timeIntervalSince1970: 1_000)
        let now = Date(timeIntervalSince1970: 1_358)
        XCTAssertEqual(ActivityFormat.line(since: since, outputTokens: 16_400, now: now), "Running… · 5m 58s · ↓ 16.4k tokens")
        XCTAssertEqual(ActivityFormat.line(since: since, outputTokens: nil, now: now), "Running… · 5m 58s")
        XCTAssertEqual(ActivityFormat.line(since: since, outputTokens: 0, now: now), "Running… · 5m 58s",
                       "zero tokens right after a prompt is not worth a word")
        XCTAssertEqual(ActivityFormat.line(since: nil, outputTokens: nil, now: now), "Running…")
    }

    func testLineSaysWhenTheCLIIsWaitingOnABackgroundTask() {
        let now = Date(timeIntervalSince1970: 1_000_100)
        let since = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(ActivityFormat.line(since: since, outputTokens: nil, now: now, reason: "background"),
                       "Waiting for a background task… · 1m 40s")
        XCTAssertEqual(ActivityFormat.line(since: since, outputTokens: 500, now: now, reason: nil),
                       "Running… · 1m 40s · ↓ 500 tokens")
    }
}
