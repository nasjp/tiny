import XCTest
@testable import Tiny

/// The list's status capsule. `Closed` is the CLI having closed the session; anything busier wins
final class SessionListBadgeTests: XCTestCase {
    private func session(status: SessionStatus = .idle, cliClosedAt: String? = nil,
                         activity: SessionActivity? = nil) -> SessionRecord {
        SessionRecord(id: "s", agentSessionId: "a", agent: "claude", profile: "default",
                      cwd: "/srv/repo", permissionMode: .default, model: nil, effort: nil,
                      title: nil, status: status, createdAt: "2026-09-02T00:00:00Z",
                      updatedAt: "2026-09-02T00:00:00Z", activity: activity, cliClosedAt: cliClosedAt)
    }

    func testClosedReplacesIdleOnly() {
        XCTAssertEqual(session().listBadge, .idle)
        XCTAssertEqual(session(cliClosedAt: "2026-09-02T01:00:00Z").listBadge, .closed)
    }

    func testBusierStatesWinOverClosed() {
        let closed = "2026-09-02T01:00:00Z"
        let busy = SessionActivity(since: "2026-09-02T01:00:00Z", outputTokens: nil)
        XCTAssertEqual(session(cliClosedAt: closed, activity: busy).listBadge, .running)
        XCTAssertEqual(session(status: .running, cliClosedAt: closed).listBadge, .running)
        XCTAssertEqual(session(status: .detached, cliClosedAt: closed).listBadge, .inCLI)
        XCTAssertEqual(session(status: .interrupted, cliClosedAt: closed).listBadge, .interrupted)
    }

    func testOlderServerWithoutTheKeyDecodesAsNotClosed() throws {
        let json = """
        {"id":"u1","agentSessionId":null,"agent":"claude","profile":"work","cwd":"/x",
         "permissionMode":"default","title":null,"status":"idle",
         "createdAt":"2026-09-02T00:00:00Z","updatedAt":"2026-09-02T00:00:00Z"}
        """
        let s = try JSONDecoder().decode(SessionRecord.self, from: Data(json.utf8))
        XCTAssertNil(s.cliClosedAt)
        XCTAssertEqual(s.listBadge, .idle)

        let withKey = json.replacingOccurrences(
            of: "\"status\":\"idle\"", with: "\"status\":\"idle\",\"cliClosedAt\":\"2026-09-02T01:00:00Z\"")
        let closed = try JSONDecoder().decode(SessionRecord.self, from: Data(withKey.utf8))
        XCTAssertEqual(closed.cliClosedAt, "2026-09-02T01:00:00Z")
        XCTAssertEqual(closed.listBadge, .closed)
    }
}
