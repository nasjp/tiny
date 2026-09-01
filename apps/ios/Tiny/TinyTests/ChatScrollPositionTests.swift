import XCTest
import SwiftUI
@testable import Tiny

/// Drives a NavigationStack push from the outside
@MainActor
final class PathBox: ObservableObject {
    @Published var ids: [String] = []
}

/// A list-like root that pushes ChatView, mirroring how the app navigates
struct PushHarness: View {
    @ObservedObject var path: PathBox
    let session: SessionRecord

    var body: some View {
        NavigationStack(path: $path.ids) {
            List { Text("sessions") }
                .navigationDestination(for: String.self) { _ in ChatView(session: session) }
        }
    }
}

/// Regression net for the device report "opening a session lands at the top of the
/// history". History arrives asynchronously (REST first, WS after), so the ScrollView
/// lays out empty and `.defaultScrollAnchor(.bottom)` has nothing to anchor to; when
/// the rows land later the offset stays where it was — at the top.
/// Assembles a real ChatView and checks the underlying UIScrollView ends up at the bottom.
@MainActor
final class ChatScrollPositionTests: XCTestCase {
    /// Delays history the way a real server does (the view renders empty first)
    final class DelayedBackend: TinyBackend, @unchecked Sendable {
        let inner: ChatViewWidthTests.FixtureBackend
        let delay: Duration
        init(_ fixture: [EventRecord], delay: Duration) {
            self.inner = ChatViewWidthTests.FixtureBackend(fixture)
            self.delay = delay
        }
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
        func events(sessionId: String, since: Int) async throws -> [EventRecord] {
            try await Task.sleep(for: delay)
            return try await inner.events(sessionId: sessionId, since: since)
        }
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

    /// Enough turns to overflow a 402x874 viewport many times over
    private static let longHistory: [EventRecord] = history(turns: 20)

    private static let hugeHistory: [EventRecord] = history(turns: 200)

    private static func history(turns: Int) -> [EventRecord] {
        var out: [EventRecord] = []
        for turn in 0..<turns {
            let base = turn * 4
            out.append(ev(base + 1, "user_message", .object(["text": .string("Question number \(turn + 1)")])))
            out.append(ev(base + 2, "turn_started", .object(["agentSessionId": .string("demo-agent")])))
            out.append(ev(base + 3, "assistant_text", .object([
                "text": .string("Answer \(turn + 1).\n\n" + String(repeating: "This is a fairly long paragraph so the row takes real height. ", count: 4)),
            ])))
            out.append(ev(base + 4, "turn_completed", .object(["costUsd": .number(0.01)])))
        }
        return out
    }

    private var windows: [UIWindow] = []

    override func tearDown() {
        windows.forEach { $0.isHidden = true }
        windows = []
        super.tearDown()
    }

    private func scrollViews(_ v: UIView) -> [UIScrollView] {
        var out: [UIScrollView] = []
        if let s = v as? UIScrollView { out.append(s) }
        for c in v.subviews { out += scrollViews(c) }
        return out
    }

    /// Puts a real ChatView on screen. The window needs a scene — without one SwiftUI
    /// never runs an update pass and the view stays frozen on its first (empty) render
    private func openChat(_ backend: TinyBackend, pumps: Int = 25) async throws -> UIScrollView {
        let appModel = AppModel()
        appModel.useBackendForTesting(backend)
        let session = try await backend.sessions()[0]
        let host = UIHostingController(rootView:
            NavigationStack { ChatView(session: session) }.environmentObject(appModel))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
        if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene {
            window.windowScene = scene
        }
        window.rootViewController = host
        window.makeKeyAndVisible()
        windows.append(window)   // keep it alive until teardown
        host.view.layoutIfNeeded()
        for _ in 0..<pumps {
            await Task.yield()
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            host.view.layoutIfNeeded()
        }
        XCTAssertGreaterThan(appModel.chatModel(for: session)?.events.count ?? 0, 0, "events are loaded")
        return try XCTUnwrap(scrollViews(host.view).first { String(describing: type(of: $0)).contains("HostingScrollView") })
    }

    private func assertAtBottom(_ sv: UIScrollView, _ message: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertGreaterThan(sv.contentSize.height, sv.bounds.height, "the history overflows the viewport",
                             file: file, line: line)
        let bottom = sv.contentSize.height - sv.bounds.height + sv.adjustedContentInset.bottom
        XCTAssertEqual(sv.contentOffset.y, bottom, accuracy: 2, message, file: file, line: line)
    }

    /// History already in hand when the view appears (the AppModel cache path)
    func testOpeningWithImmediateHistoryLandsAtTheBottom() async throws {
        let sv = try await openChat(ChatViewWidthTests.FixtureBackend(Self.longHistory))
        assertAtBottom(sv, "the chat opens pinned to the newest message, not at the top")
    }

    /// The real navigation path: the chat is pushed onto a NavigationStack (the push
    /// animation resizes the scroll view while history is still arriving)
    func testPushingTheChatOntoTheStackLandsAtTheBottom() async throws {
        let backend = DelayedBackend(Self.longHistory, delay: .milliseconds(400))
        let appModel = AppModel()
        appModel.useBackendForTesting(backend)
        let session = try await backend.sessions()[0]
        let path = PathBox()
        let host = UIHostingController(rootView:
            PushHarness(path: path, session: session).environmentObject(appModel))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
        if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene {
            window.windowScene = scene
        }
        window.rootViewController = host
        window.makeKeyAndVisible()
        windows.append(window)
        host.view.layoutIfNeeded()
        for _ in 0..<5 {
            await Task.yield()
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        }
        path.ids = [session.id]   // push, animated, like a tap in the list
        for _ in 0..<25 {
            await Task.yield()
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            host.view.layoutIfNeeded()
        }
        let sv = try XCTUnwrap(scrollViews(host.view).first { String(describing: type(of: $0)).contains("HostingScrollView") })
        assertAtBottom(sv, "a pushed chat lands at the newest message")
    }

    /// A long-running session: hundreds of turns of history
    func testOpeningAHugeHistoryLandsAtTheBottom() async throws {
        let sv = try await openChat(DelayedBackend(Self.hugeHistory, delay: .milliseconds(400)))
        assertAtBottom(sv, "a huge history still lands at the newest message")
    }

    /// History arrives after the first layout (the real server path)
    func testOpeningWithDelayedHistoryLandsAtTheBottom() async throws {
        let sv = try await openChat(DelayedBackend(Self.longHistory, delay: .milliseconds(400)))
        assertAtBottom(sv, "history arriving late still lands at the newest message")
    }
}

/// The opening window itself (pure timing logic, no view involved)
final class BottomPinTests: XCTestCase {
    func testArmingOpensAWindowAndLateContentExtendsIt() {
        let t0 = Date()
        let pin = BottomPin()
        pin.arm(now: t0)
        XCTAssertTrue(pin.active)
        XCTAssertEqual(pin.until.timeIntervalSince(t0), BottomPin.window, accuracy: 0.01,
                       "a fresh chat pins to the bottom for the whole opening window")

        // A row landing right at the end of the window buys a little more time
        pin.extend(now: t0.addingTimeInterval(BottomPin.window - 0.1))
        XCTAssertEqual(pin.until.timeIntervalSince(t0),
                       BottomPin.window - 0.1 + BottomPin.perChange, accuracy: 0.01)

        // An earlier change never shortens the window
        pin.extend(now: t0)
        XCTAssertEqual(pin.until.timeIntervalSince(t0),
                       BottomPin.window - 0.1 + BottomPin.perChange, accuracy: 0.01)
    }

    func testAChatThatKeepsGrowingStopsPinningAtTheHardDeadline() {
        let t0 = Date()
        let pin = BottomPin()
        pin.arm(now: t0)
        for step in stride(from: 0.0, through: BottomPin.hardWindow + 10, by: 0.5) {
            pin.extend(now: t0.addingTimeInterval(step))
        }
        XCTAssertEqual(pin.until.timeIntervalSince(t0), BottomPin.hardWindow, accuracy: 0.01,
                       "a running turn never keeps the pin alive past the hard deadline")
    }

    func testAnInactivePinIsNotRevivedByLateContent() {
        let t0 = Date()
        let pin = BottomPin()
        pin.arm(now: t0)
        pin.active = false   // the user scrolled
        pin.extend(now: t0.addingTimeInterval(1))
        XCTAssertEqual(pin.until.timeIntervalSince(t0), BottomPin.window, accuracy: 0.01)
        XCTAssertFalse(pin.active)
    }
}
