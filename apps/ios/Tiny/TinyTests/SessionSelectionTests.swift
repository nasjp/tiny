import XCTest
@testable import Tiny

final class SessionSelectionTests: XCTestCase {
    private func session(_ id: String, status: SessionStatus = .idle) -> SessionRecord {
        SessionRecord(id: id, agentSessionId: nil, agent: "claude", profile: "default",
                      cwd: "/srv/\(id)", permissionMode: .default, model: nil, effort: nil,
                      title: nil, status: status, createdAt: "2026-09-01T00:00:00Z",
                      updatedAt: "2026-09-01T00:00:00Z")
    }

    func testCanArchiveFollowsTheSwipeRule() {
        XCTAssertTrue(session("a", status: .idle).canArchive)
        XCTAssertTrue(session("a", status: .interrupted).canArchive)
        XCTAssertFalse(session("a", status: .running).canArchive)
        XCTAssertFalse(session("a", status: .detached).canArchive)
    }

    func testToggleAndClear() {
        var sel = SessionSelection()
        XCTAssertTrue(sel.isEmpty)
        sel.toggle("a")
        XCTAssertTrue(sel.contains("a"))
        sel.toggle("a")
        XCTAssertFalse(sel.contains("a"))
        sel.select("b")
        sel.select("b")
        XCTAssertTrue(sel.contains("b"))
        sel.clear()
        XCTAssertTrue(sel.isEmpty)
    }

    func testSelectAllAddsOnlyTheCandidatesGiven() {
        var sel = SessionSelection()
        sel.selectAll([session("a"), session("b")])
        XCTAssertTrue(sel.contains("a") && sel.contains("b"))
        XCTAssertFalse(sel.contains("c"))
    }

    func testChosenKeepsListOrderAndDropsMissingOrIneligibleRows() {
        var sel = SessionSelection()
        ["c", "a", "gone", "r"].forEach { sel.select($0) }
        let list = [session("a"), session("b"), session("r", status: .running), session("c")]
        XCTAssertEqual(sel.chosen(from: list, where: \.canArchive), ["a", "c"])
        XCTAssertEqual(sel.chosen(from: list, where: { _ in true }), ["a", "r", "c"])
    }

    func testAllSelected() {
        var sel = SessionSelection()
        let list = [session("a"), session("b")]
        XCTAssertFalse(sel.allSelected(among: list))
        XCTAssertFalse(sel.allSelected(among: []))
        sel.selectAll(list)
        XCTAssertTrue(sel.allSelected(among: list))
        sel.toggle("b")
        XCTAssertFalse(sel.allSelected(among: list))
    }
}
