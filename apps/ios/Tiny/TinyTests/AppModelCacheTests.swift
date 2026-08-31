import XCTest
@testable import Tiny

/// The cache that keeps screen round trips from flickering (ChatModel reuse; invalidated on backend switch)
@MainActor
final class AppModelCacheTests: XCTestCase {
    private func demoSession(_ model: AppModel) async throws -> SessionRecord {
        model.enterDemo()
        let sessions = try await model.backend!.sessions()
        return sessions[0]
    }

    func testChatModelIsReusedForSameSession() async throws {
        let model = AppModel()
        let session = try await demoSession(model)
        let first = model.chatModel(for: session)
        let second = model.chatModel(for: session)
        XCTAssertNotNil(first)
        XCTAssertTrue(first === second, "the same session returns the same ChatModel (events persist, no flicker)")
    }

    func testChatModelCacheIsClearedWhenBackendChanges() async throws {
        let model = AppModel()
        let session = try await demoSession(model)
        let first = model.chatModel(for: session)
        model.enterDemo()   // backend swap = cache invalidation
        let second = model.chatModel(for: session)
        XCTAssertFalse(first === second, "never reuse an old ChatModel after the backend changes")
    }

    func testSessionCacheIsClearedOnUnpair() async throws {
        let model = AppModel()
        let session = try await demoSession(model)
        model.sessions = [session]
        model.sessionsLoaded = true
        model.unpair()
        XCTAssertTrue(model.sessions.isEmpty)
        XCTAssertFalse(model.sessionsLoaded)
    }
}
