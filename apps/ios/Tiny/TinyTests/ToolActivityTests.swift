import XCTest
@testable import Tiny

final class ToolActivityTests: XCTestCase {
    private func ev(_ id: Int, _ type: String, _ payload: JSONValue) -> EventRecord {
        EventRecord(id: id, sessionId: "s", type: type, payload: payload, createdAt: "c")
    }

    func testGroupingCollapsesConsecutiveToolsAndSplitsOnText() {
        let events = [
            ev(1, "user_message", .object(["text": .string("go")])),
            ev(2, "turn_started", .object([:])),
            ev(3, "tool_started", .object(["toolName": .string("Bash"), "toolUseId": .string("t1"),
                                           "input": .object(["command": .string("ls")])])),
            ev(4, "tool_finished", .object(["toolUseId": .string("t1"), "isError": .bool(false)])),
            ev(5, "tool_started", .object(["toolName": .string("Edit"), "toolUseId": .string("t2"),
                                           "input": .object(["file_path": .string("/a/b/ChatView.swift")])])),
            ev(6, "tool_finished", .object(["toolUseId": .string("t2"), "isError": .bool(true)])),
            ev(7, "assistant_text", .object(["text": .string("done")])),
            ev(8, "tool_started", .object(["toolName": .string("Read"), "toolUseId": .string("t3"),
                                           "input": .object(["file_path": .string("/a/x.md")])])),
        ]
        let items = buildChatItems(events)
        XCTAssertEqual(items.count, 4)   // user / tools(2) / text / tools(1)
        guard case .tools(_, let group1) = items[1] else { return XCTFail("\(items[1])") }
        XCTAssertEqual(group1.map(\.name), ["Bash", "Edit"])
        XCTAssertEqual(group1.map(\.isError), [false, true])
        guard case .event(let text) = items[2] else { return XCTFail("\(items[2])") }
        XCTAssertEqual(text.id, 7)
        guard case .tools(_, let group2) = items[3] else { return XCTFail("\(items[3])") }
        XCTAssertEqual(group2.map(\.name), ["Read"])
    }

    func testAnswersOfAskUserQuestionBecomeQACard() {
        // AskUserQuestion never shows as "Ran 1 tool"; on answering it becomes a
        // question+answer .qa card. Card order follows the question order from
        // permission_requested (not the answers dictionary's ordering).
        // Plain permissions without answers stay hidden as before (and don't split groups)
        func q(_ text: String) -> JSONValue {
            .object(["question": .string(text), "header": .string("H"),
                     "multiSelect": .bool(false),
                     "options": .array([
                         .object(["label": .string("A"), "description": .string("")]),
                         .object(["label": .string("B"), "description": .string("")]),
                     ])])
        }
        let events = [
            ev(1, "tool_started", .object(["toolName": .string("AskUserQuestion"),
                                           "toolUseId": .string("t1"), "input": .object([:])])),
            ev(2, "permission_requested", .object([
                "reqId": .string("r1"), "toolName": .string("AskUserQuestion"),
                // Names chosen so sorted-key order (a… < b…) differs from question order (b… first)
                "input": .object(["questions": .array([q("b sorts-second name"), q("a first question")])])])),
            ev(3, "permission_resolved", .object(["reqId": .string("r1"), "behavior": .string("allow"),
                                                  "answers": .object(["b sorts-second name": .string("A"),
                                                                      "a first question": .string("B")])])),
            ev(4, "tool_finished", .object(["toolUseId": .string("t1"), "isError": .bool(false)])),
            ev(5, "assistant_text", .object(["text": .string("Sorry, that's incorrect")])),
            ev(6, "permission_resolved", .object(["reqId": .string("r2"), "behavior": .string("allow")])),
        ]
        let items = buildChatItems(events)
        XCTAssertEqual(items.count, 2)   // qa card / text (tool rows and plain-permission resolved don't appear)
        guard case .qa(let id, let pairs) = items[0] else { return XCTFail("\(items[0])") }
        XCTAssertEqual(id, 3)
        XCTAssertEqual(pairs, [QAPair(question: "b sorts-second name", answer: "A"),
                               QAPair(question: "a first question", answer: "B")])   // question order preserved
        guard case .event(let text) = items[1] else { return XCTFail("\(items[1])") }
        XCTAssertEqual(text.id, 5)
    }

    func testStateChangeRunsCollapse() {
        // A detach/resume volley ending in resume (idle) shows no rows at all
        let toggles = [
            ev(1, "assistant_text", .object(["text": .string("done")])),
            ev(2, "session_state_changed", .object(["status": .string("detached")])),
            ev(3, "session_state_changed", .object(["status": .string("idle")])),
            ev(4, "session_state_changed", .object(["status": .string("detached")])),
            ev(5, "session_state_changed", .object(["status": .string("idle")])),
        ]
        let items = buildChatItems(toggles)
        XCTAssertEqual(items.count, 1)
        guard case .event(let only) = items[0] else { return XCTFail("\(items[0])") }
        XCTAssertEqual(only.id, 1)

        // Ending in detached leaves only the last row
        let endsDetached = toggles + [ev(6, "session_state_changed", .object(["status": .string("detached")]))]
        let items2 = buildChatItems(endsDetached)
        XCTAssertEqual(items2.count, 2)
        guard case .event(let marker) = items2[1] else { return XCTFail("\(items2[1])") }
        XCTAssertEqual(marker.id, 6)

        // Real content in between splits the runs and each is judged separately
        let mixed = [
            ev(1, "session_state_changed", .object(["status": .string("detached")])),
            ev(2, "assistant_text", .object(["text": .string("a")])),
            ev(3, "session_state_changed", .object(["status": .string("idle")])),
        ]
        let items3 = buildChatItems(mixed)
        XCTAssertEqual(items3.count, 2)   // detached marker + text (the trailing idle disappears)
        guard case .event(let first) = items3[0] else { return XCTFail("\(items3[0])") }
        XCTAssertEqual(first.id, 1)
    }

    func testSummaryCounts() {
        func call(_ name: String) -> ToolCall {
            ToolCall(id: UUID().uuidString, name: name, input: .object([:]), isError: false)
        }
        XCTAssertEqual(toolGroupSummary([call("Bash"), call("Bash"), call("Edit")]),
                       "Ran 2 commands, edited 1 file")
        XCTAssertEqual(toolGroupSummary([call("Read")]), "Ran 1 tool")
        XCTAssertEqual(toolGroupSummary([call("Bash"), call("WebFetch")]),
                       "Ran 1 command, 1 other tool")
    }

    func testCallLabelsAndVerbs() {
        let bash = ToolCall(id: "1", name: "Bash",
                            input: .object(["command": .string("npm test"),
                                            "description": .string("Run tests")]), isError: false)
        XCTAssertEqual(bash.label, "Run tests")
        XCTAssertEqual(bash.verb, "Ran")
        XCTAssertEqual(bash.iconName, "terminal")

        let edit = ToolCall(id: "2", name: "Edit",
                            input: .object(["file_path": .string("/deep/path/ChatView.swift")]), isError: false)
        XCTAssertEqual(edit.label, "ChatView.swift")
        XCTAssertEqual(edit.verb, "Edited")
        XCTAssertEqual(edit.iconName, "pencil")

        let send = ToolCall(id: "3", name: "mcp__tiny__send_user_file",
                            input: .object(["path": .string("/tmp/report.html")]), isError: false)
        XCTAssertEqual(send.label, "Sent: report.html")
    }

    // A CLI-owned session asks through the transcript, not the permission flow: cli_question /
    // cli_question_answered. Both the question and the chosen answer have to survive in history
    func testCLIQuestionShowsReadOnlyCardThenTurnsIntoTheAnswerCard() {
        func q(_ text: String) -> JSONValue {
            .object(["question": .string(text), "header": .string("Goal"),
                     "multiSelect": .bool(false),
                     "options": .array([
                         .object(["label": .string("staging"), "description": .string("")]),
                         .object(["label": .string("production"), "description": .string("")]),
                     ])])
        }
        let asked = ev(1, "cli_question", .object([
            "toolUseId": .string("t1"), "input": .object(["questions": .array([q("Which goal?")])])]))

        // While the CLI waits, the question is on screen read-only
        let pending = buildChatItems([asked])
        XCTAssertEqual(pending.count, 1)
        guard case .cliQuestion(_, _, let questions) = pending[0] else { return XCTFail("\(pending[0])") }
        XCTAssertEqual(questions.map(\.question), ["Which goal?"])
        XCTAssertEqual(questions.first?.options.map(\.label), ["staging", "production"])

        // Once answered in the CLI it becomes the answer card, in the same place
        let answered = buildChatItems([
            asked,
            ev(2, "cli_question_answered", .object([
                "toolUseId": .string("t1"),
                "answers": .object(["Which goal?": .string("staging")])])),
        ])
        XCTAssertEqual(answered.count, 1)
        guard case .qa(let id, let pairs) = answered[0] else { return XCTFail("\(answered[0])") }
        XCTAssertEqual(id, 1)   // keeps the question's identity, so the card is not re-inserted
        XCTAssertEqual(pairs, [QAPair(question: "Which goal?", answer: "staging")])
    }

    func testDismissedCLIQuestionKeepsTheQuestionInHistory() {
        let events = [
            ev(1, "cli_question", .object([
                "toolUseId": .string("t1"),
                "input": .object(["questions": .array([.object([
                    "question": .string("Which goal?"), "header": .string("Goal"),
                    "multiSelect": .bool(false),
                    "options": .array([.object(["label": .string("staging"), "description": .string("")])]),
                ])])])])),
            ev(2, "cli_question_answered", .object([
                "toolUseId": .string("t1"), "answers": .object([:]), "rejected": .bool(true)])),
        ]
        let items = buildChatItems(events)
        XCTAssertEqual(items.count, 1)
        guard case .qa(_, let pairs) = items[0] else { return XCTFail("\(items[0])") }
        XCTAssertEqual(pairs, [QAPair(question: "Which goal?", answer: dismissedInCLIAnswer)])
    }

    func testAnswersWhoseQuestionFellOutsideTheWindowStillShow() {
        let items = buildChatItems([
            ev(9, "cli_question_answered", .object([
                "toolUseId": .string("t1"),
                "answers": .object(["Which goal?": .string("production")])])),
        ])
        XCTAssertEqual(items.count, 1)
        guard case .qa(let id, let pairs) = items[0] else { return XCTFail("\(items[0])") }
        XCTAssertEqual(id, 9)
        XCTAssertEqual(pairs, [QAPair(question: "Which goal?", answer: "production")])
    }

    func testChosenAnswersWinOverTheCancelledPromptWhicheverArrivesFirst() {
        // Answering from the phone makes the CLI cancel its own prompt, which it records as a
        // rejection. Either order must leave one card, showing what was chosen (device report:
        // three answers all read "Dismissed in the CLI")
        func question(_ id: Int) -> EventRecord {
            ev(id, "cli_question", .object([
                "toolUseId": .string("t1"),
                "input": .object(["questions": .array([.object([
                    "question": .string("Which goal?"), "header": .string("Goal"),
                    "multiSelect": .bool(false),
                    "options": .array([.object(["label": .string("staging"), "description": .string("")])]),
                ])])]),
            ]))
        }
        let dismissal = ev(2, "cli_question_answered", .object([
            "toolUseId": .string("t1"), "answers": .object([:]), "rejected": .bool(true)]))
        let answer = ev(3, "cli_question_answered", .object([
            "toolUseId": .string("t1"), "answers": .object(["Which goal?": .string("staging")])]))

        for events in [[question(1), dismissal, answer], [question(1), answer, dismissal]] {
            let items = buildChatItems(events)
            XCTAssertEqual(items.count, 1, "\(items)")
            guard case .qa(_, let pairs) = items[0] else { return XCTFail("\(items[0])") }
            XCTAssertEqual(pairs, [QAPair(question: "Which goal?", answer: "staging")])
        }
    }
}
