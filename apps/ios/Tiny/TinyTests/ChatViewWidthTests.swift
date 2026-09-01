import XCTest
import SwiftUI
@testable import Tiny

/// Regression net for the device report where the whole chat starts dragging
/// sideways the moment a wide table (containing a horizontal ScrollView) arrives.
/// Assembles a real ChatView and checks the outer UIScrollView's content width
/// never exceeds the viewport and horizontal bounce is disabled
@MainActor
final class ChatViewWidthTests: XCTestCase {
    /// Swaps only events; everything else delegates to DemoBackend
    final class FixtureBackend: TinyBackend, @unchecked Sendable {
        let inner = DemoBackend()
        let fixture: [EventRecord]
        init(_ fixture: [EventRecord]) { self.fixture = fixture }
        var isDemo: Bool { true }
        func profiles() async throws -> [ProfileInfo] { try await inner.profiles() }
        func profileUsage(name: String) async throws -> ProfileUsage { try await inner.profileUsage(name: name) }
        func sessions() async throws -> [SessionRecord] { try await inner.sessions() }
        func archivedSessions() async throws -> [SessionRecord] { try await inner.archivedSessions() }
        func setArchived(sessionId: String, archived: Bool) async throws -> SessionRecord {
            try await inner.setArchived(sessionId: sessionId, archived: archived)
        }
        func recentCwds() async throws -> [String] { try await inner.recentCwds() }
        func createSession(profile: String, cwd: String, permissionMode: PermissionMode, model: String?, effort: String?) async throws -> SessionRecord {
            try await inner.createSession(profile: profile, cwd: cwd, permissionMode: permissionMode, model: model, effort: effort)
        }
        func events(sessionId: String, since: Int) async throws -> [EventRecord] { fixture.filter { $0.id > since } }
        func sendTurn(sessionId: String, prompt: String, images: [TurnImageAttachment]) async throws {}
        func interrupt(sessionId: String) async throws {}
        func setDetached(sessionId: String, detached: Bool) async throws {}
        func updateSession(sessionId: String, model: String?, permissionMode: PermissionMode?, effort: String?, title: String?) async throws -> SessionRecord {
            try await inner.updateSession(sessionId: sessionId, model: model, permissionMode: permissionMode, effort: effort, title: title)
        }
        func pendingPermissions(sessionId: String) async throws -> [PendingPermission] { [] }

    func answerCliQuestion(sessionId: String, toolUseId: String, answers: [String: String]) async throws {}

        func respondPermission(reqId: String, allow: Bool, message: String?, updatedInput: JSONValue?) async throws {}
        func fileData(fileId: String) async throws -> (data: Data, mime: String) { try await inner.fileData(fileId: fileId) }
        func eventStream(sessionId: String, since: Int) -> AsyncStream<EventRecord> { AsyncStream { _ in } }
    }

    private static func ev(_ id: Int, _ type: String, _ payload: JSONValue) -> EventRecord {
        EventRecord(id: id, sessionId: "demo-session-1", type: type, payload: payload,
                    createdAt: "2026-08-29T07:38:42.048Z")
    }

    /// A table of 11 columns × long-text cells + a long code line + a 4-image bubble
    private static let wideEvents: [EventRecord] = {
        let header = "| " + (1...11).map { "col\($0)" }.joined(separator: " | ") + " |"
        let sep = "|" + Array(repeating: "---", count: 11).joined(separator: "|") + "|"
        let row = "| " + (1...11).map { "**very long cell content \($0)** weekends 11:30-18:00 nonstop (L.O. 17:30), cards and transit IC accepted" }.joined(separator: " | ") + " |"
        let table = ([header, sep] + Array(repeating: row, count: 8)).joined(separator: "\n")
        let code = "```\nconst veryLongIdentifierName = someFunctionCall(argumentOne, argumentTwo, argumentThree, argumentFour, argumentFive);\n```"
        return [
            ev(1, "user_message", .object(["text": .string("https://tabelog.com/tokyo/A1310/A131002/13000340/\n\nHeading to this place right now"),
                                           "imageFileIds": .array([.string("a"), .string("b"), .string("c"), .string("d")])])),
            ev(2, "turn_started", .object(["agentSessionId": .string("demo-agent")])),
            ev(3, "assistant_text", .object(["text": .string("## Places confirmed open on Saturday\n\n" + table + "\n\n---\n\n" + code)])),
            ev(4, "turn_completed", .object(["costUsd": .number(0.12)])),
        ]
    }()

    private func scrollViews(_ v: UIView) -> [UIScrollView] {
        var out: [UIScrollView] = []
        if let s = v as? UIScrollView { out.append(s) }
        for c in v.subviews { out += scrollViews(c) }
        return out
    }

    func testChatContentNeverWiderThanViewport() async throws {
        let backend = FixtureBackend(Self.wideEvents)
        let appModel = AppModel()
        appModel.useBackendForTesting(backend)
        let session = try await backend.sessions()[0]

        let host = UIHostingController(rootView:
            NavigationStack { ChatView(session: session) }.environmentObject(appModel))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
        // Without a scene the window gets no update pass and the view would stay frozen
        // on its first (empty) render, making every assertion below vacuous
        if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene {
            window.windowScene = scene
        }
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        for _ in 0..<15 {
            await Task.yield()
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            host.view.layoutIfNeeded()
        }
        XCTAssertEqual(appModel.chatModel(for: session)?.events.count, Self.wideEvents.count, "events are loaded")
        let outer = try XCTUnwrap(scrollViews(host.view).first { String(describing: type(of: $0)).contains("HostingScrollView") })
        XCTAssertEqual(outer.contentSize.width, outer.bounds.width, "body width never exceeds the viewport")
        XCTAssertFalse(outer.alwaysBounceHorizontal, "horizontal bounce is disabled")
        XCTAssertTrue(outer.isDirectionalLockEnabled)
        XCTAssertEqual(outer.contentOffset.x, -outer.adjustedContentInset.left, "no residual horizontal offset")
    }
}
