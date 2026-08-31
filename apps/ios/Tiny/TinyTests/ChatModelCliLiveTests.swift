import XCTest
@testable import Tiny

/// isHeldByCLI on ChatModel mirrors isDetached: sourced from the pushed SessionRecord at init,
/// then kept fresh via refreshCliLive() (no WS push exists for cliLive, unlike sessionStateChanged
/// for isDetached, so the model refreshes it itself instead of trusting the stale pushed value).
@MainActor
final class ChatModelCliLiveTests: XCTestCase {
    private class MockBackend: TinyBackend {
        let isDemo = true
        var sessionsList: [SessionRecord] = []

        func profiles() async throws -> [ProfileInfo] { [] }
        func profileUsage(name: String) async throws -> ProfileUsage { throw APIError(status: 404, message: "n/a") }
        func sessions() async throws -> [SessionRecord] { sessionsList }
        func archivedSessions() async throws -> [SessionRecord] { [] }
        func recentCwds() async throws -> [String] { [] }
        func setArchived(sessionId: String, archived: Bool) async throws -> SessionRecord {
            throw APIError(status: 0, message: "unused in tests")
        }
        func createSession(profile: String, cwd: String, permissionMode: PermissionMode, model: String?, effort: String?) async throws -> SessionRecord {
            throw APIError(status: 404, message: "n/a")
        }
        func events(sessionId: String, since: Int) async throws -> [EventRecord] { [] }
        func sendTurn(sessionId: String, prompt: String, images: [TurnImageAttachment]) async throws {}
        func interrupt(sessionId: String) async throws {}
        func setDetached(sessionId: String, detached: Bool) async throws {}
        func updateSession(sessionId: String, model: String?, permissionMode: PermissionMode?, effort: String?, title: String?) async throws -> SessionRecord {
            throw APIError(status: 404, message: "n/a")
        }
        func pendingPermissions(sessionId: String) async throws -> [PendingPermission] { [] }
        func respondPermission(reqId: String, allow: Bool, message: String?, updatedInput: JSONValue?) async throws {}
        func fileData(fileId: String) async throws -> (data: Data, mime: String) { (Data(), "text/plain") }
        func eventStream(sessionId: String, since: Int) -> AsyncStream<EventRecord> {
            AsyncStream { $0.finish() }
        }
    }

    private func makeSession(cliLive: Bool?, cliJoin: Bool? = nil, activity: SessionActivity? = nil) -> SessionRecord {
        SessionRecord(id: "s1", agentSessionId: nil, agent: "claude", profile: "default",
                      cwd: "/tmp", permissionMode: .default, model: nil, effort: nil,
                      title: nil, status: .idle, createdAt: "2026-08-31T00:00:00Z",
                      updatedAt: "2026-08-31T00:00:00Z", cliLive: cliLive, cliJoin: cliJoin, activity: activity)
    }

    private let busy = SessionActivity(since: "2026-08-31T12:06:55.000Z", outputTokens: 597)

    func testActivityFromThePushedSessionShowsRunning() {
        let model = ChatModel(backend: MockBackend(), session: makeSession(cliLive: true, cliJoin: true, activity: busy))
        XCTAssertTrue(model.isBusy, "a turn typed into the CLI is running here too")
        XCTAssertEqual(model.busySince, EventRow.parseISO("2026-08-31T12:06:55.000Z"))
        XCTAssertEqual(model.busyOutputTokens, 597)
    }

    func testRefreshPicksUpTheCLIStartingAndFinishingATurn() async {
        let backend = MockBackend()
        let model = ChatModel(backend: backend, session: makeSession(cliLive: true, cliJoin: true))
        XCTAssertFalse(model.isBusy)
        backend.sessionsList = [makeSession(cliLive: true, cliJoin: true, activity: busy)]
        await model.refreshCliLive()
        XCTAssertTrue(model.isBusy, "the CLI starting a turn must show Running without reopening the chat")
        backend.sessionsList = [makeSession(cliLive: true, cliJoin: true)]
        await model.refreshCliLive()
        XCTAssertFalse(model.isBusy, "and going idle over there must take the Running row away")
    }

    func testTurnEndClearsActivityWithoutWaitingForAPoll() {
        let model = ChatModel(backend: MockBackend(), session: makeSession(cliLive: true, cliJoin: true, activity: busy))
        model.handle(EventRecord(id: 7, sessionId: "s1", type: "turn_completed", payload: .object([:]),
                                 createdAt: "2026-08-31T12:10:00.000Z"))
        XCTAssertFalse(model.isBusy)
        XCTAssertNil(model.busySince)
    }

    func testStopFailureIsShown() async {
        final class FailingBackend: MockBackend {
            override func interrupt(sessionId: String) async throws {
                throw APIError(status: 409, message: "the CLI holds this session but tiny cannot reach it")
            }
        }
        let model = ChatModel(backend: FailingBackend(), session: makeSession(cliLive: true, cliJoin: true, activity: busy))
        await model.interrupt()
        XCTAssertEqual(model.errorBanner, "Could not stop: the CLI holds this session but tiny cannot reach it")
    }

    func testInitSourcesFromThePushedSession() {
        let backend = MockBackend()
        let model = ChatModel(backend: backend, session: makeSession(cliLive: true))
        XCTAssertTrue(model.isHeldByCLI)
    }

    func testRefreshPicksUpTheCLIReleasingTheSession() async {
        let backend = MockBackend()
        let model = ChatModel(backend: backend, session: makeSession(cliLive: true))
        XCTAssertTrue(model.isHeldByCLI)
        backend.sessionsList = [makeSession(cliLive: false)]
        await model.refreshCliLive()
        XCTAssertFalse(model.isHeldByCLI, "closing the CLI must unlock the composer without reopening the chat")
    }

    func testRefreshPicksUpTheCLITakingTheSessionMidChat() async {
        let backend = MockBackend()
        let model = ChatModel(backend: backend, session: makeSession(cliLive: false))
        XCTAssertFalse(model.isHeldByCLI)
        backend.sessionsList = [makeSession(cliLive: true)]
        await model.refreshCliLive()
        XCTAssertTrue(model.isHeldByCLI, "the CLI taking the session mid-chat must lock the composer")
    }

    func testRefreshLeavesStateUnchangedWhenTheSessionIsMissingFromTheList() async {
        let backend = MockBackend()
        let model = ChatModel(backend: backend, session: makeSession(cliLive: true))
        backend.sessionsList = []
        await model.refreshCliLive()
        XCTAssertTrue(model.isHeldByCLI, "a failed or empty fetch must not silently unlock the composer")
    }

    func testRefreshUnlocksOnceTheServerCanJoinTheCLI() async {
        let backend = MockBackend()
        let model = ChatModel(backend: backend, session: makeSession(cliLive: true, cliJoin: false))
        XCTAssertTrue(model.isHeldByCLI)
        backend.sessionsList = [makeSession(cliLive: true, cliJoin: true)]
        await model.refreshCliLive()
        XCTAssertFalse(model.isHeldByCLI, "once tinyd can join, the composer must unlock without reopening the chat")
    }
}
