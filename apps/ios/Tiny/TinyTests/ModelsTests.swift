import XCTest
@testable import Tiny

final class ModelsTests: XCTestCase {
    private func decodeEvent(_ json: String) throws -> EventRecord {
        try JSONDecoder().decode(EventRecord.self, from: Data(json.utf8))
    }

    func testSessionRecordDecodesWithNulls() throws {
        let json = """
        {"id":"u1","agentSessionId":null,"agent":"claude","profile":"work",
         "cwd":"/Users/x/repo","permissionMode":"default","title":null,
         "status":"idle","createdAt":"2026-08-27T00:00:00Z","updatedAt":"2026-08-27T00:00:00Z"}
        """
        let s = try JSONDecoder().decode(SessionRecord.self, from: Data(json.utf8))
        XCTAssertNil(s.agentSessionId)
        XCTAssertNil(s.title)
        XCTAssertEqual(s.status, .idle)
    }

    func testTurnCompletedNullableFields() throws {
        let ev = try decodeEvent("""
        {"id":5,"sessionId":"s","type":"turn_completed",
         "payload":{"costUsd":null,"resultText":null},"createdAt":"c"}
        """)
        guard case let .turnCompleted(cost, text, ctx) = ev.event else { return XCTFail("\(ev.event)") }
        XCTAssertNil(cost); XCTAssertNil(text); XCTAssertNil(ctx)
    }

    func testTurnCompletedWithValues() throws {
        let ev = try decodeEvent("""
        {"id":6,"sessionId":"s","type":"turn_completed",
         "payload":{"costUsd":0.42,"resultText":"done","contextTokens":95210},"createdAt":"c"}
        """)
        guard case let .turnCompleted(cost, text, ctx) = ev.event else { return XCTFail("\(ev.event)") }
        XCTAssertEqual(cost, 0.42); XCTAssertEqual(text, "done"); XCTAssertEqual(ctx, 95210)
    }

    // turn_failed has two payload shapes ({subtype} from SDK non-success / {error} from the exception path)
    func testTurnFailedBothShapes() throws {
        let a = try decodeEvent("""
        {"id":7,"sessionId":"s","type":"turn_failed","payload":{"subtype":"error_max_turns"},"createdAt":"c"}
        """)
        guard case let .turnFailed(reason) = a.event else { return XCTFail("\(a.event)") }
        XCTAssertEqual(reason, "error_max_turns")

        let b = try decodeEvent("""
        {"id":8,"sessionId":"s","type":"turn_failed","payload":{"error":"aborted"},"createdAt":"c"}
        """)
        guard case let .turnFailed(reason2) = b.event else { return XCTFail("\(b.event)") }
        XCTAssertEqual(reason2, "aborted")
    }

    func testPermissionRequested() throws {
        let ev = try decodeEvent("""
        {"id":9,"sessionId":"s","type":"permission_requested",
         "payload":{"reqId":"r1","toolName":"Bash","input":{"command":"ls -la"}},"createdAt":"c"}
        """)
        guard case let .permissionRequested(reqId, tool, input) = ev.event else { return XCTFail("\(ev.event)") }
        XCTAssertEqual(reqId, "r1")
        XCTAssertEqual(tool, "Bash")
        XCTAssertEqual(input.objectValue?["command"]?.stringValue, "ls -la")
    }

    func testFileSentNameIsMacAbsolutePath() throws {
        let ev = try decodeEvent("""
        {"id":10,"sessionId":"s","type":"file_sent",
         "payload":{"fileId":"f1","mime":"text/html","caption":null,"name":"/Users/x/report.html"},"createdAt":"c"}
        """)
        guard case let .fileSent(fileId, mime, caption, name) = ev.event else { return XCTFail("\(ev.event)") }
        XCTAssertEqual(fileId, "f1"); XCTAssertEqual(mime, "text/html")
        XCTAssertNil(caption); XCTAssertEqual(name, "/Users/x/report.html")
    }

    func testUserMessageDecodes() throws {
        let ev = try decodeEvent("""
        {"id":12,"sessionId":"s","type":"user_message","payload":{"text":"hi"},"createdAt":"c"}
        """)
        guard case let .userMessage(text, imageCount, imageFileIds) = ev.event else { return XCTFail("\(ev.event)") }
        XCTAssertEqual(text, "hi")
        XCTAssertEqual(imageCount, 0)
        XCTAssertEqual(imageFileIds, [])
    }

    func testUserMessageDecodesImageFileIds() throws {
        let ev = try decodeEvent("""
        {"id":13,"sessionId":"s","type":"user_message",\
        "payload":{"text":"look","imageCount":2,"imageFileIds":["f1","f2"]},"createdAt":"c"}
        """)
        guard case let .userMessage(text, imageCount, imageFileIds) = ev.event else { return XCTFail("\(ev.event)") }
        XCTAssertEqual(text, "look")
        XCTAssertEqual(imageCount, 2)
        XCTAssertEqual(imageFileIds, ["f1", "f2"])
    }

    func testParseISOVariants() {
        XCTAssertNotNil(EventRow.parseISO("2026-08-27T08:48:43.474Z"))          // tinyd (ms)
        XCTAssertNotNil(EventRow.parseISO("2026-08-27T09:10:00+00:00"))          // no fraction
        XCTAssertNotNil(EventRow.parseISO("2026-08-27T09:10:00.308722+00:00"))   // usage API (µs)
        XCTAssertNil(EventRow.parseISO("not-a-date"))
    }

    func testMarkdownTableHelpers() {
        XCTAssertTrue(MarkdownText.isTableSeparator("|---|:---:|---|"))
        XCTAssertTrue(MarkdownText.isTableSeparator("| --- | --- |"))
        XCTAssertFalse(MarkdownText.isTableSeparator("| a | b |"))
        XCTAssertFalse(MarkdownText.isTableSeparator("plain text"))
        XCTAssertEqual(MarkdownText.tableCells("| A | B | C |"), ["A", "B", "C"])
        XCTAssertEqual(MarkdownText.tableCells("|x|y|"), ["x", "y"])
    }

    func testUnknownEventTypeBecomesUnknown() throws {
        let ev = try decodeEvent("""
        {"id":11,"sessionId":"s","type":"some_future_event","payload":{"x":1},"createdAt":"c"}
        """)
        guard case .unknown = ev.event else { return XCTFail("must not crash on a future event type: \(ev.event)") }
    }

    func testPairQRParse() {
        let qr = PairQR.parse(#"{"url":"http://mac:7777","code":"K7MPQ2XA"}"#)
        XCTAssertEqual(qr?.url, "http://mac:7777")
        XCTAssertEqual(qr?.code, "K7MPQ2XA")
        XCTAssertNil(PairQR.parse("https://example.com/not-json"))
    }

    func testAskUserQuestionParse() throws {
        let input = try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"questions":[{"question":"Which approach?","header":"Approach","multiSelect":false,
          "options":[{"label":"Quick fix","description":"Patch now."},
                     {"label":"Refactor","description":"Do it right."}]},
         {"question":"Which features?","header":"Features","multiSelect":true,
          "options":[{"label":"A","description":""},{"label":"B","description":""}]}]}
        """.utf8))
        let questions = AskUserQuestion.parse(input)
        XCTAssertEqual(questions.count, 2)
        XCTAssertEqual(questions[0].question, "Which approach?")
        XCTAssertEqual(questions[0].header, "Approach")
        XCTAssertFalse(questions[0].multiSelect)
        XCTAssertEqual(questions[0].options.map(\.label), ["Quick fix", "Refactor"])
        XCTAssertEqual(questions[0].options[0].description, "Patch now.")
        XCTAssertTrue(questions[1].multiSelect)
        // Unexpected shapes yield an empty array (falls back to the plain permission banner)
        XCTAssertTrue(AskUserQuestion.parse(.object(["command": .string("ls")])).isEmpty)
        XCTAssertTrue(AskUserQuestion.parse(.null).isEmpty)
    }

    func testAskUserQuestionUpdatedInputKeepsOriginalAndAddsAnswers() throws {
        let input = try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"questions":[{"question":"Q1","header":"H","multiSelect":false,
          "options":[{"label":"A","description":""},{"label":"B","description":""}]}]}
        """.utf8))
        let updated = AskUserQuestion.updatedInput(original: input, answers: ["Q1": "A, B"])
        let obj = updated.objectValue
        XCTAssertNotNil(obj?["questions"])   // keeps the original questions
        XCTAssertEqual(obj?["answers"]?.objectValue?["Q1"]?.stringValue, "A, B")
    }

    func testPermissionResolvedCarriesAnswers() throws {
        let ev = try decodeEvent("""
        {"id":12,"sessionId":"s","type":"permission_resolved",
         "payload":{"reqId":"r1","behavior":"allow","answers":{"Which one?":"Option A"}},"createdAt":"c"}
        """)
        guard case .permissionResolved(let reqId, let behavior, let answers) = ev.event else {
            return XCTFail("unexpected: \(ev.event)")
        }
        XCTAssertEqual(reqId, "r1")
        XCTAssertEqual(behavior, "allow")
        XCTAssertEqual(answers, ["Which one?": "Option A"])
        // Plain permissions without answers are nil
        let plain = try decodeEvent("""
        {"id":13,"sessionId":"s","type":"permission_resolved",
         "payload":{"reqId":"r2","behavior":"deny"},"createdAt":"c"}
        """)
        guard case .permissionResolved(_, _, let none) = plain.event else {
            return XCTFail("unexpected: \(plain.event)")
        }
        XCTAssertNil(none)
    }

    func testSessionRecordArchivedAtDecoding() throws {
        // With archivedAt
        let withArchived = """
        {"id":"s1","agentSessionId":null,"agent":"claude","profile":"work","cwd":"/tmp",
         "permissionMode":"default","model":null,"effort":null,"title":null,"status":"idle",
         "archivedAt":"2026-08-28T00:00:00.000Z",
         "createdAt":"2026-08-28T00:00:00.000Z","updatedAt":"2026-08-28T00:00:00.000Z"}
        """
        let a = try JSONDecoder().decode(SessionRecord.self, from: Data(withArchived.utf8))
        XCTAssertEqual(a.archivedAt, "2026-08-28T00:00:00.000Z")
        // No key (old server) must not fail either
        let withoutKey = """
        {"id":"s2","agentSessionId":null,"agent":"claude","profile":"work","cwd":"/tmp",
         "permissionMode":"default","model":null,"effort":null,"title":null,"status":"idle",
         "createdAt":"2026-08-28T00:00:00.000Z","updatedAt":"2026-08-28T00:00:00.000Z"}
        """
        let b = try JSONDecoder().decode(SessionRecord.self, from: Data(withoutKey.utf8))
        XCTAssertNil(b.archivedAt)
    }

    func testDecodesCliLiveWhenPresent() throws {
        let json = """
        {"id":"s1","agentSessionId":"a1","agent":"claude","profile":"local","cwd":"/tmp",
         "permissionMode":"default","model":null,"effort":null,"title":"t","status":"idle",
         "createdAt":"2026-08-31T00:00:00Z","updatedAt":"2026-08-31T00:00:00Z","cliLive":true}
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(SessionRecord.self, from: json)
        XCTAssertEqual(s.cliLive, true)
        XCTAssertTrue(s.isHeldByCLI)
    }

    func testCliLiveDefaultsToNilOnOlderServers() throws {
        let json = """
        {"id":"s1","agentSessionId":"a1","agent":"claude","profile":"work","cwd":"/tmp",
         "permissionMode":"default","model":null,"effort":null,"title":"t","status":"idle",
         "createdAt":"2026-08-31T00:00:00Z","updatedAt":"2026-08-31T00:00:00Z"}
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(SessionRecord.self, from: json)
        XCTAssertNil(s.cliLive)
        // Undetermined must never lock the composer
        XCTAssertFalse(s.isHeldByCLI)
    }

    func testPushIntentDecodesWithAndWithoutReqId() throws {
        let a = try JSONDecoder().decode(PushIntent.self, from: Data("""
        {"v":1,"type":"permission_requested","sessionId":"s","eventId":42,
         "title":"my-repo","body":"Requesting permission to run Bash",
         "category":"tiny.permission","level":"time-sensitive","reqId":"r1"}
        """.utf8))
        XCTAssertEqual(a.reqId, "r1")
        let b = try JSONDecoder().decode(PushIntent.self, from: Data("""
        {"v":1,"type":"turn_completed","sessionId":"s","eventId":43,
         "title":"t","body":"b","category":"tiny.info","level":"active"}
        """.utf8))
        XCTAssertNil(b.reqId)
    }
}
