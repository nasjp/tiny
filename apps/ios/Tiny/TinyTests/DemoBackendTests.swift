import XCTest
@testable import Tiny

final class DemoBackendTests: XCTestCase {
    func testHasSessionsAndHistory() async throws {
        let demo = DemoBackend()
        let sessions = try await demo.sessions()
        XCTAssertFalse(sessions.isEmpty)
        let events = try await demo.events(sessionId: sessions[0].id, since: 0)
        XCTAssertFalse(events.isEmpty)
    }

    func testSendTurnProducesAssistantReplyOnStream() async throws {
        let demo = DemoBackend()
        let sid = (try await demo.sessions())[0].id
        let history = try await demo.events(sessionId: sid, since: 0)
        let lastId = history.map(\.id).max() ?? 0

        var got: [TinyEvent] = []
        let exp = expectation(description: "turn completes")
        let task = Task {
            for await ev in demo.eventStream(sessionId: sid, since: lastId) {
                got.append(ev.event)
                if case .turnCompleted = ev.event { exp.fulfill(); break }
            }
        }
        try await demo.sendTurn(sessionId: sid, prompt: "test", images: [])
        await fulfillment(of: [exp], timeout: 10)
        task.cancel()

        XCTAssertTrue(got.contains { if case .turnStarted = $0 { return true }; return false })
        XCTAssertTrue(got.contains { if case .assistantText = $0 { return true }; return false })
    }

    func testPermissionFlow() async throws {
        let demo = DemoBackend()
        let sid = (try await demo.sessions())[0].id
        try await demo.sendTurn(sessionId: sid, prompt: "build it", images: [])   // the scenario that raises a permission request
        try await Task.sleep(nanoseconds: 2_000_000_000)
        let pending = try await demo.pendingPermissions(sessionId: sid)
        XCTAssertEqual(pending.count, 1)
        try await demo.respondPermission(reqId: pending[0].id, allow: true, message: nil, updatedInput: nil)
        let after = try await demo.pendingPermissions(sessionId: sid)
        XCTAssertTrue(after.isEmpty)
    }

    func testAskUserQuestionFlow() async throws {
        let demo = DemoBackend()
        let sid = (try await demo.sessions())[0].id
        try await demo.sendTurn(sessionId: sid, prompt: "I have a question", images: [])
        try await Task.sleep(nanoseconds: 2_000_000_000)
        let pending = try await demo.pendingPermissions(sessionId: sid)
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0].toolName, "AskUserQuestion")
        let questions = AskUserQuestion.parse(pending[0].input)
        XCTAssertEqual(questions.count, 1)
        XCTAssertEqual(questions[0].options.count, 2)
        let updated = AskUserQuestion.updatedInput(
            original: pending[0].input,
            answers: [questions[0].question: questions[0].options[0].label])
        try await demo.respondPermission(reqId: pending[0].id, allow: true, message: nil,
                                         updatedInput: updated)
        let after = try await demo.pendingPermissions(sessionId: sid)
        XCTAssertTrue(after.isEmpty)
    }

    func testArchiveTogglesListMembership() async throws {
        let backend = DemoBackend()
        let initial = try await backend.sessions()
        XCTAssertEqual(initial.count, 3)
        var archived = try await backend.archivedSessions()
        XCTAssertEqual(archived.count, 0)

        _ = try await backend.setArchived(sessionId: initial[0].id, archived: true)
        var active = try await backend.sessions()
        XCTAssertEqual(active.count, 2)
        archived = try await backend.archivedSessions()
        XCTAssertEqual(archived.count, 1)

        _ = try await backend.setArchived(sessionId: initial[0].id, archived: false)
        active = try await backend.sessions()
        XCTAssertEqual(active.count, 3)
        archived = try await backend.archivedSessions()
        XCTAssertEqual(archived.count, 0)
    }

    func testHasThreeSessionsWithTheirOwnHistories() async throws {
        let demo = DemoBackend()
        let sessions = try await demo.sessions()
        XCTAssertEqual(sessions.count, 3)
        XCTAssertEqual(sessions.map(\.status), [.idle, .idle, .interrupted])
        let first = try await demo.events(sessionId: sessions[0].id, since: 0)
        let second = try await demo.events(sessionId: sessions[1].id, since: 0)
        XCTAssertFalse(second.isEmpty)
        XCTAssertNotEqual(first.map(\.type), second.map(\.type))
        XCTAssertTrue(second.allSatisfy { $0.sessionId == sessions[1].id })
    }

    func testArchivingSeveralSessionsMovesThemTogether() async throws {
        let demo = DemoBackend()
        let ids = try await demo.sessions().map(\.id)
        _ = try await demo.setArchived(sessionId: ids[1], archived: true)
        _ = try await demo.setArchived(sessionId: ids[2], archived: true)
        let active = try await demo.sessions().map(\.id)
        XCTAssertEqual(active, [ids[0]])
        let archived = try await demo.archivedSessions().map(\.id)
        XCTAssertEqual(archived, [ids[1], ids[2]])
    }

    /// A turn sent in one session must not show up in another's stream
    func testTurnEventsStayInTheirSession() async throws {
        let demo = DemoBackend()
        let sessions = try await demo.sessions()
        let before = try await demo.events(sessionId: sessions[0].id, since: 0)
        try await demo.sendTurn(sessionId: sessions[1].id, prompt: "hello", images: [])
        try await Task.sleep(nanoseconds: 2_000_000_000)
        let firstAfter = try await demo.events(sessionId: sessions[0].id, since: 0)
        XCTAssertEqual(firstAfter.count, before.count)
        let second = try await demo.events(sessionId: sessions[1].id, since: 0)
        XCTAssertTrue(second.contains { $0.type == "user_message" && $0.payload.objectValue?["text"]?.stringValue == "hello" })
    }

    /// cwd history survives archiving (New Session candidates don't disappear)
    func testRecentCwdsSurvivesArchive() async throws {
        let backend = DemoBackend()
        let initial = try await backend.sessions()
        let before = try await backend.recentCwds()
        XCTAssertEqual(before, initial.map(\.cwd))

        _ = try await backend.setArchived(sessionId: initial[0].id, archived: true)
        let after = try await backend.recentCwds()
        XCTAssertEqual(after, initial.map(\.cwd))
    }

    func testFileData() async throws {
        let demo = DemoBackend()
        let (data, mime) = try await demo.fileData(fileId: DemoBackend.demoFileId)
        XCTAssertEqual(mime, "text/html")
        XCTAssertFalse(data.isEmpty)
    }
}
