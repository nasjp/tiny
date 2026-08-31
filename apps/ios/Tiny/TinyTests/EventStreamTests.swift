import XCTest
@testable import Tiny

final class EventStreamTests: XCTestCase {
    func testWsURLFromHttp() {
        let url = EventStreamPolicy.wsURL(
            baseURL: URL(string: "http://mac:7777")!,
            sessionId: "s1", token: "tok", since: 42)
        XCTAssertEqual(url.absoluteString, "ws://mac:7777/v1/sessions/s1/stream?token=tok&since=42")
    }

    // The QR's url can be https depending on TINY_SERVER_URL. Never hardcode the scheme
    func testWsURLFromHttps() {
        let url = EventStreamPolicy.wsURL(
            baseURL: URL(string: "https://mac.tailnet.ts.net")!,
            sessionId: "s1", token: "tok", since: 0)
        XCTAssertTrue(url.absoluteString.hasPrefix("wss://mac.tailnet.ts.net/"))
    }

    func testReconnectPolicy() {
        XCTAssertFalse(EventStreamPolicy.shouldReconnect(closeCode: 4401), "4401 requires re-pairing")
        XCTAssertFalse(EventStreamPolicy.shouldReconnect(closeCode: 1000), "normal closure")
        XCTAssertTrue(EventStreamPolicy.shouldReconnect(closeCode: 1006), "abnormal closure should reconnect")
        XCTAssertTrue(EventStreamPolicy.shouldReconnect(closeCode: nil), "unknown code should also reconnect")
    }

    func testBackoffCapsAt30Seconds() {
        XCTAssertEqual(EventStreamPolicy.backoffSeconds(attempt: 0), 1)
        XCTAssertEqual(EventStreamPolicy.backoffSeconds(attempt: 3), 8)
        XCTAssertEqual(EventStreamPolicy.backoffSeconds(attempt: 10), 30)
    }
}
