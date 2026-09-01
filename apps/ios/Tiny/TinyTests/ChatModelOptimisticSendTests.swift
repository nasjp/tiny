import XCTest
@testable import Tiny

/// Optimistic send UI (spec: docs/superpowers/specs/2026-08-28-optimistic-send-design.md).
/// The user's bubble and the Running indicator appear with the send tap and are swapped for the real WS events.
@MainActor
final class ChatModelOptimisticSendTests: XCTestCase {
    private final class MockBackend: TinyBackend {
        let isDemo = true
        var sendError: Error?
        var sentPrompts: [String] = []
        var historyEvents: [EventRecord] = []

        func profiles() async throws -> [ProfileInfo] { [] }
        func profileUsage(name: String) async throws -> ProfileUsage { throw APIError(status: 404, message: "n/a") }
        func sessions() async throws -> [SessionRecord] { [] }
        func archivedSessions() async throws -> [SessionRecord] { [] }
        func recentCwds() async throws -> [String] { [] }
        func setArchived(sessionId: String, archived: Bool) async throws -> SessionRecord {
            throw APIError(status: 0, message: "unused in tests")
        }
        func createSession(profile: String, cwd: String, permissionMode: PermissionMode, model: String?, effort: String?) async throws -> SessionRecord {
            throw APIError(status: 404, message: "n/a")
        }
        func events(sessionId: String, since: Int) async throws -> [EventRecord] { historyEvents }
        func sendTurn(sessionId: String, prompt: String, images: [TurnImageAttachment]) async throws {
            if let sendError { throw sendError }
            sentPrompts.append(prompt)
        }
        func interrupt(sessionId: String) async throws {}
        func setDetached(sessionId: String, detached: Bool) async throws {}
        func updateSession(sessionId: String, model: String?, permissionMode: PermissionMode?, effort: String?, title: String?) async throws -> SessionRecord {
            throw APIError(status: 404, message: "n/a")
        }
        func pendingPermissions(sessionId: String) async throws -> [PendingPermission] { [] }

    var answeredQuestions: [(toolUseId: String, answers: [String: String])] = []
    var failAnswerWith: Error?
    func answerCliQuestion(sessionId: String, toolUseId: String, answers: [String: String]) async throws {
        answeredQuestions.append((toolUseId, answers))
        if let failAnswerWith { throw failAnswerWith }
    }

        func respondPermission(reqId: String, allow: Bool, message: String?, updatedInput: JSONValue?) async throws {}
        func fileData(fileId: String) async throws -> (data: Data, mime: String) { (Data(), "text/plain") }
        func eventStream(sessionId: String, since: Int) -> AsyncStream<EventRecord> {
            AsyncStream { $0.finish() }
        }
    }

    private func makeSession() -> SessionRecord {
        SessionRecord(id: "s1", agentSessionId: nil, agent: "claude", profile: "default",
                      cwd: "/tmp", permissionMode: .default, model: nil, effort: nil,
                      title: nil, status: .idle, createdAt: "2026-08-28T00:00:00Z",
                      updatedAt: "2026-08-28T00:00:00Z")
    }

    private func record(id: Int, type: String, payload: JSONValue = .object([:])) -> EventRecord {
        EventRecord(id: id, sessionId: "s1", type: type, payload: payload,
                    createdAt: "2026-08-28T00:00:01Z")
    }

    func testSendAddsPlaceholderAndBusy() async {
        let backend = MockBackend()
        let model = ChatModel(backend: backend, session: makeSession())
        XCTAssertFalse(model.isBusy)
        let ok = await model.send(prompt: "hello")
        XCTAssertTrue(ok)
        XCTAssertEqual(model.pendingSends.map(\.text), ["hello"])
        XCTAssertTrue(model.isBusy, "shows Running even before turn_started")
        XCTAssertNil(model.errorBanner)
    }

    func testMatchingUserMessageRemovesPlaceholder() async {
        let backend = MockBackend()
        let model = ChatModel(backend: backend, session: makeSession())
        await model.send(prompt: "hello")
        model.handle(record(id: 1, type: "user_message",
                            payload: .object(["text": .string("hello"), "imageCount": .number(0)])))
        XCTAssertTrue(model.pendingSends.isEmpty, "swapped for the real event, no double display")
        XCTAssertEqual(model.events.count, 1)
    }

    func testUnmatchedUserMessageRemovesOldestPlaceholder() async {
        let backend = MockBackend()
        let model = ChatModel(backend: backend, session: makeSession())
        await model.send(prompt: "first")
        // Even without a text match, drop the oldest placeholder (no debris from a missed match)
        model.handle(record(id: 1, type: "user_message",
                            payload: .object(["text": .string("edited"), "imageCount": .number(0)])))
        XCTAssertTrue(model.pendingSends.isEmpty)
    }

    func testSendFailureRollsBackAndReturnsFalse() async {
        let backend = MockBackend()
        backend.sendError = APIError(status: 409, message: "turn already running")
        let model = ChatModel(backend: backend, session: makeSession())
        let ok = await model.send(prompt: "hello")
        XCTAssertFalse(ok)
        XCTAssertTrue(model.pendingSends.isEmpty, "rolls back the placeholder on failure")
        XCTAssertFalse(model.isBusy)
        XCTAssertNotNil(model.errorBanner)
    }

    func testTurnCompletedClearsLeftoverPlaceholders() async {
        let backend = MockBackend()
        let model = ChatModel(backend: backend, session: makeSession())
        await model.send(prompt: "hello")
        model.handle(record(id: 2, type: "turn_completed"))
        XCTAssertTrue(model.pendingSends.isEmpty, "safety net: everything cleared at turn end")
        XCTAssertFalse(model.isBusy)
    }

    /// The optimistic display stacks in the same frame as the send tap (no await in between).
    /// If this goes async again, the device symptom "lag before Running appears" comes back
    func testBeginSendIsSynchronous() {
        let backend = MockBackend()
        let model = ChatModel(backend: backend, session: makeSession())
        XCTAssertFalse(model.isBusy)
        let placeholder = model.beginSend(prompt: "hello")
        XCTAssertTrue(model.isBusy, "shows Running with no await in between")
        XCTAssertEqual(model.pendingSends.map(\.id), [placeholder.id])
    }

    func testDeliverFailureRollsBackPlaceholder() async {
        let backend = MockBackend()
        backend.sendError = APIError(status: 409, message: "session is attached from CLI")
        let model = ChatModel(backend: backend, session: makeSession())
        let placeholder = model.beginSend(prompt: "hello")
        let ok = await model.deliver(placeholder, prompt: "hello")
        XCTAssertFalse(ok)
        XCTAssertTrue(model.pendingSends.isEmpty)
        XCTAssertEqual(model.errorBanner, "In use by CLI (tiny attach)")
    }

    /// The appear-effect boundary. Rows poured in as history get no effect; only later WS arrivals do
    func testHistoryIsNotAnimatedButLaterEventsAre() async {
        let backend = MockBackend()
        backend.historyEvents = [record(id: 4, type: "assistant_text",
                                        payload: .object(["text": .string("hi")])),
                                 record(id: 7, type: "turn_completed")]
        let model = ChatModel(backend: backend, session: makeSession())
        XCTAssertFalse(model.isNewlyArrived(7), "nothing counts as new before the history fetch")
        model.start()
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertFalse(model.isNewlyArrived(4), "rows on screen from the start get no effect")
        XCTAssertFalse(model.isNewlyArrived(7))
        XCTAssertTrue(model.isNewlyArrived(8), "only rows arriving after the history animate in")
        model.stop()
    }

    func testEmptyHistoryAnimatesEveryArrival() async {
        let backend = MockBackend()
        let model = ChatModel(backend: backend, session: makeSession())
        model.start()
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertTrue(model.isNewlyArrived(1), "a fresh session animates from the very first event")
        model.stop()
    }

    func testHistoryReloadClearsPlaceholders() async {
        let backend = MockBackend()
        backend.historyEvents = [record(id: 1, type: "user_message",
                                        payload: .object(["text": .string("hello"), "imageCount": .number(0)]))]
        let model = ChatModel(backend: backend, session: makeSession())
        await model.send(prompt: "hello")
        model.start()
        // Wait for start()'s async history fetch to complete
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertTrue(model.pendingSends.isEmpty, "the real one is in the history now, so the placeholder is dropped")
        model.stop()
    }
}
