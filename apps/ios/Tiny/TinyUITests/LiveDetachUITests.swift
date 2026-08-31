import XCTest

/// Live E2E connecting to a real tinyd (127.0.0.1:7777). Runs only when the env var TINY_LIVE_E2E=1.
/// How to pass them (the TEST_RUNNER_ prefix passes through to the test runner):
///   TEST_RUNNER_TINY_LIVE_E2E=1 TEST_RUNNER_TINY_TOKEN=<CLI token> \
///   TEST_RUNNER_TINY_PAIR_CODE=<unused pair code> xcodebuild test ... -only-testing:TinyUITests/LiveDetachUITests
/// Repro/regression test for the device incident "UI freezes right after receiving a detach event".
final class LiveDetachUITests: XCTestCase {
    private let base = URL(string: "http://127.0.0.1:7777")!

    @discardableResult
    private func api(_ method: String, _ path: String, token: String,
                     body: [String: Any]? = nil) -> Data {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        var result = Data()
        let exp = expectation(description: "api \(path)")
        URLSession.shared.dataTask(with: req) { d, _, _ in
            result = d ?? Data()
            exp.fulfill()
        }.resume()
        wait(for: [exp], timeout: 10)
        return result
    }

    private func sessionIds(token: String) -> [String] {
        let data = api("GET", "/v1/sessions", token: token)
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = obj["sessions"] as? [[String: Any]] else { return [] }
        return list.compactMap { $0["id"] as? String }
    }

    func testDetachWhileChatOpenDoesNotFreeze() throws {
        let env = ProcessInfo.processInfo.environment
        guard env["TINY_LIVE_E2E"] == "1" else { throw XCTSkip("TINY_LIVE_E2E not set") }
        guard let token = env["TINY_TOKEN"], !token.isEmpty else { throw XCTSkip("TINY_TOKEN not set") }

        let app = XCUIApplication()
        app.launch()

        // If unpaired the pairing screen appears, so pair by manual entry
        if app.navigationBars["Pairing"].waitForExistence(timeout: 5) {
            guard let code = env["TINY_PAIR_CODE"], !code.isEmpty else {
                throw XCTSkip("Not paired and TINY_PAIR_CODE is missing")
            }
            app.staticTexts["Enter manually (QR code won't scan)"].tap()
            let urlField = app.textFields["pairURLField"]
            XCTAssertTrue(urlField.waitForExistence(timeout: 5), "Manual entry fields didn't open")
            urlField.tap()
            urlField.typeText("http://127.0.0.1:7777")
            let codeField = app.textFields["pairCodeField"]
            codeField.tap()
            codeField.typeText(code)
            app.buttons["Pair"].tap()
        }

        // Session list → open the first session
        XCTAssertTrue(app.cells.firstMatch.waitForExistence(timeout: 15), "Session list didn't appear")
        app.cells.firstMatch.tap()
        let input = app.descendants(matching: .any)["chatInput"]
        XCTAssertTrue(input.waitForExistence(timeout: 10), "Chat screen didn't open")

        // Detach while chat is shown → session_state_changed pours in over WS (repro condition for the device freeze)
        let ids = sessionIds(token: token)
        XCTAssertFalse(ids.isEmpty)
        for id in ids { api("POST", "/v1/sessions/\(id)/detach", token: token, body: ["detached": true]) }
        defer {
            for id in ids { api("POST", "/v1/sessions/\(id)/detach", token: token, body: ["detached": false]) }
        }

        // Wait for the event to land, then confirm the UI is alive
        sleep(5)
        XCTAssertTrue(app.staticTexts["— Handed off to CLI —"].waitForExistence(timeout: 10),
                      "Detach event wasn't reflected on screen")
        XCTAssertTrue(input.isHittable, "Input field isn't responding (possible main thread hang)")
        input.tap()
        input.typeText("freeze check")

        // Sending while detached becomes a 409 error banner
        app.buttons["sendButton"].tap()
        XCTAssertTrue(app.staticTexts["In use by CLI (tiny attach)"].waitForExistence(timeout: 10),
                      "409 error banner didn't appear")

        // "Resume here" takes the detached session back
        let resume = app.buttons["resumeFromCLIButton"]
        XCTAssertTrue(resume.waitForExistence(timeout: 5), "Resume button didn't appear")
        resume.tap()
        // A state-change round trip ending in resume (idle) shows no marker by design,
        // so verify the resume via the banner (resume button) disappearing
        let resumed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: resume)
        wait(for: [resumed], timeout: 10)

        // Can navigate back to the list (navigation is alive too)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.cells.firstMatch.waitForExistence(timeout: 10), "Couldn't navigate back to the list")
    }

    /// The ↓ button appears when not at the bottom and tapping returns to the bottom
    func testScrollToBottomButton() throws {
        let env = ProcessInfo.processInfo.environment
        guard env["TINY_LIVE_E2E"] == "1" else { throw XCTSkip("TINY_LIVE_E2E not set") }
        let app = XCUIApplication()
        app.launch()
        guard app.cells.firstMatch.waitForExistence(timeout: 15) else { throw XCTSkip("Not paired") }
        // Open a session with a long history (the README one)
        let target = app.cells.containing(NSPredicate(format: "label CONTAINS 'README'")).firstMatch
        (target.exists ? target : app.cells.firstMatch).tap()
        XCTAssertTrue(app.descendants(matching: .any)["chatInput"].waitForExistence(timeout: 10))

        let button = app.buttons["scrollToBottomButton"]
        XCTAssertFalse(button.exists, "Shouldn't appear at the bottom")
        app.swipeDown()   // scroll up (view the older end)
        app.swipeDown()
        XCTAssertTrue(button.waitForExistence(timeout: 5), "Scroll-to-bottom button didn't appear after scrolling")
        button.tap()
        // Once back at the bottom the button disappears
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: button)
        wait(for: [gone], timeout: 5)
    }

    /// Repro condition for device freeze #2: pouring in WS events while the file
    /// sheet (WKWebView) stays open must not freeze
    func testFileSheetOpenWhileEventsArriveDoesNotFreeze() throws {
        let env = ProcessInfo.processInfo.environment
        guard env["TINY_LIVE_E2E"] == "1" else { throw XCTSkip("TINY_LIVE_E2E not set") }
        guard let token = env["TINY_TOKEN"], !token.isEmpty else { throw XCTSkip("TINY_TOKEN not set") }

        let app = XCUIApplication()
        app.launch()
        // This test assumes pairing is done (testDetach... pairs first)
        guard app.cells.firstMatch.waitForExistence(timeout: 15) else {
            throw XCTSkip("Not paired (run testDetachWhileChatOpenDoesNotFreeze first)")
        }
        // Prefer a session with file_sent history (the README-summary one)
        let target = app.cells.containing(
            NSPredicate(format: "label CONTAINS 'README'")).firstMatch
        (target.exists ? target : app.cells.firstMatch).tap()
        let input = app.descendants(matching: .any)["chatInput"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))

        // Find and tap a file card (doc-icon button) in the history. Skip if there is none
        let fileCard = app.buttons.matching(
            NSPredicate(format: "label CONTAINS '.html' OR label CONTAINS 'report'")).firstMatch
        guard fileCard.waitForExistence(timeout: 5) else {
            throw XCTSkip("No file card in history")
        }
        fileCard.tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10), "File sheet didn't open")

        // With the sheet open, round-trip detach/restore a few times to pour in events
        let ids = sessionIds(token: token)
        for _ in 0..<3 {
            for id in ids { api("POST", "/v1/sessions/\(id)/detach", token: token, body: ["detached": true]) }
            for id in ids { api("POST", "/v1/sessions/\(id)/detach", token: token, body: ["detached": false]) }
        }
        sleep(3)

        // The sheet's close button is alive = the main thread is not frozen
        let close = app.buttons["Done"]
        XCTAssertTrue(close.isHittable, "Close button isn't responding (possible freeze)")
        close.tap()
        XCTAssertTrue(input.waitForExistence(timeout: 10), "Couldn't get back to chat after closing the sheet")
        input.tap()
        input.typeText("alive check")
    }
}
