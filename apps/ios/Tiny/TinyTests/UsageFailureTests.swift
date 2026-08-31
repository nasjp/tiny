import XCTest
@testable import Tiny

/// A profile whose usage cannot be read used to paste the server's whole reply on screen —
/// a 401 body, JSON and all. What the phone shows now is one line, the command that fixes it,
/// and the raw text one tap out of sight.
final class UsageFailureTests: XCTestCase {
    private func apiError(_ status: Int, _ message: String,
                          problem: String? = nil, hint: String? = nil, detail: String? = nil) -> APIError {
        APIError(status: status, message: message, problem: problem, hint: hint, detail: detail)
    }

    func testSignedOutShowsTheLoginCommandAndKeepsTheBodyInDetails() {
        let raw = "401 Unauthorized; body={\"error\":{\"code\":\"token_invalidated\"}}"
        let f = UsageFailure.from(apiError(409, "Codex is signed out on your Mac",
                                           problem: "signed_out", hint: "tiny profiles login cx", detail: raw))
        XCTAssertEqual(f.title, "Codex is signed out on your Mac")
        XCTAssertEqual(f.hint, "tiny profiles login cx")
        XCTAssertEqual(f.detail, raw)
        XCTAssertEqual(f.tone, .alert)
    }

    // Not an error: this login simply has no usage to report
    func testUnavailableAndUnsupportedAreMuted() {
        let unavailable = UsageFailure.from(apiError(409, "Usage is not available for this login", problem: "unavailable"))
        XCTAssertEqual(unavailable.tone, .muted)
        XCTAssertNil(unavailable.hint)
        XCTAssertNil(unavailable.detail)
        XCTAssertEqual(UsageFailure.from(apiError(409, "Usage is not available for opencode", problem: "unsupported")).tone,
                       .muted)
    }

    func testSomethingBrokeIsAnAlert() {
        let f = UsageFailure.from(apiError(502, "Could not read usage from Claude",
                                           problem: "failed", detail: "spawn claude ENOENT"))
        XCTAssertEqual(f.tone, .alert)
        XCTAssertEqual(f.detail, "spawn claude ENOENT")
    }

    /// An older tinyd answers with the raw text and no `problem`. Cut it down to a title and
    /// move the whole thing into Details, so the wall never comes back
    func testAServerWithoutTheProblemFieldStillGetsOneLine() {
        let raw = String(repeating: "failed to fetch codex rate limits: 401 Unauthorized; body={...} ", count: 6)
        let f = UsageFailure.from(apiError(500, raw))
        XCTAssertLessThanOrEqual(f.title.count, 120)
        XCTAssertTrue(f.title.hasSuffix("…"), "the long text is elided, not printed whole")
        XCTAssertEqual(f.detail, raw)
        XCTAssertEqual(f.tone, .alert)
    }

    func testAShortMessageFromAnOlderServerIsShownAsIs() {
        let f = UsageFailure.from(apiError(500, "profile not found: nope"))
        XCTAssertEqual(f.title, "profile not found: nope")
        XCTAssertNil(f.detail, "nothing to hide when the message is already one line")
    }

    /// A transport failure (Mac asleep, Tailscale down) never reaches the server's error shape
    func testANonAPIErrorFallsBackToItsDescription() {
        struct Boom: LocalizedError { var errorDescription: String? { "The request timed out." } }
        let f = UsageFailure.from(Boom())
        XCTAssertEqual(f.title, "The request timed out.")
        XCTAssertEqual(f.tone, .alert)
    }
}

/// Usage numbers can come from Claude Code's own cache rather than a live read, so the card says
/// how old they are — but only when that is worth saying
final class UsageFreshnessTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_788_181_000)   // 2026-08-31 13:36:40Z

    func testFreshNumbersCarryNoTimestamp() {
        let iso = ISO8601DateFormatter().string(from: now.addingTimeInterval(-60))
        XCTAssertNil(UsageView.freshnessText(iso, now: now))
    }

    func testStaleNumbersSayWhenTheyWereTaken() {
        let iso = ISO8601DateFormatter().string(from: now.addingTimeInterval(-3600))
        let text = UsageView.freshnessText(iso, now: now)
        XCTAssertNotNil(text)
        XCTAssertTrue(text!.hasPrefix("As of "), text ?? "")
        XCTAssertTrue(text!.contains("ago"), text ?? "")
    }

    func testAnUnparseableTimestampIsLeftOut() {
        XCTAssertNil(UsageView.freshnessText("not a date", now: now))
    }
}
