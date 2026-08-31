import XCTest
import UserNotifications
@testable import Tiny

final class NotificationContentTests: XCTestCase {
    func testPermissionIntentMapsToTimeSensitiveWithActions() {
        let intent = PushIntent(
            v: 1, type: "permission_requested", sessionId: "s1", eventId: 42,
            title: "my-repo", body: "Requesting permission to run Bash",
            category: "tiny.permission", level: "time-sensitive", reqId: "r1")
        let c = PushCrypto.notificationContent(for: intent)
        XCTAssertEqual(c.title, "my-repo")
        XCTAssertEqual(c.categoryIdentifier, "tiny.permission")
        XCTAssertEqual(c.interruptionLevel, .timeSensitive)
        let tiny = c.userInfo["tiny"] as? [String: Any]
        XCTAssertEqual(tiny?["sessionId"] as? String, "s1")
        XCTAssertEqual(tiny?["reqId"] as? String, "r1")
        XCTAssertEqual(tiny?["eventId"] as? Int, 42)
    }

    func testInfoIntentMapsToActive() {
        let intent = PushIntent(
            v: 1, type: "turn_completed", sessionId: "s2", eventId: 7,
            title: "t", body: "b", category: "tiny.info", level: "active", reqId: nil)
        let c = PushCrypto.notificationContent(for: intent)
        XCTAssertEqual(c.interruptionLevel, .active)
        let tiny = c.userInfo["tiny"] as? [String: Any]
        XCTAssertNil(tiny?["reqId"])
    }
}
