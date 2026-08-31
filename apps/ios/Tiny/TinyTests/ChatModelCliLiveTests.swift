import XCTest
@testable import Tiny

/// isHeldByCLI on ChatModel mirrors isDetached: sourced from the pushed SessionRecord at init,
/// then kept fresh via refreshCliLive() (no WS push exists for cliLive, unlike sessionStateChanged
/// for isDetached, so the model refreshes it itself instead of trusting the stale pushed value).
@MainActor
final class ChatModelCliLiveTests: XCTestCase {
    private final class MockBackend: TinyBackend {
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

    private func makeSession(cliLive: Bool?) -> SessionRecord {
        SessionRecord(id: "s1", agentSessionId: nil, agent: "claude", profile: "default",
                      cwd: "/tmp", permissionMode: .default, model: nil, effort: nil,
                      title: nil, status: .idle, createdAt: "2026-08-31T00:00:00Z",
                      updatedAt: "2026-08-31T00:00:00Z", cliLive: cliLive)
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
}
