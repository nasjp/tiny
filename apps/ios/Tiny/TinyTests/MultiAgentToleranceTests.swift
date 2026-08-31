import XCTest
@testable import Tiny

/// Phase A (groundwork for multi-agent support, iOS side):
/// pins that when the server returns non-Claude vocabulary (unknown permission modes,
/// tool kinds, capabilities, labels) the app does not crash, and behavior with the
/// current server stays unchanged.
final class MultiAgentToleranceTests: XCTestCase {
    private let decoder = JSONDecoder()

    // MARK: - PermissionMode is no longer a closed enum (unknown values must not fail decoding)

    func testSessionRecordDecodesUnknownPermissionMode() throws {
        let json = """
        {"id":"u1","agentSessionId":null,"agent":"codex","profile":"cx",
         "cwd":"/Users/x/repo","permissionMode":"workspace-write","title":null,
         "status":"idle","createdAt":"2026-08-29T00:00:00Z","updatedAt":"2026-08-29T00:00:00Z"}
        """
        let s = try decoder.decode(SessionRecord.self, from: Data(json.utf8))
        XCTAssertEqual(s.permissionMode.rawValue, "workspace-write")
        XCTAssertEqual(s.agent, "codex")
    }

    func testPermissionModeEncodesAsBareString() throws {
        let data = try JSONEncoder().encode(PermissionMode.acceptEdits)
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "\"acceptEdits\"")
        let back = try decoder.decode(PermissionMode.self, from: data)
        XCTAssertEqual(back, .acceptEdits)
    }

    func testPermissionModeLabelsKnownAndUnknown() {
        XCTAssertEqual(PermissionMode.default.label, "Ask first")
        XCTAssertEqual(PermissionMode.acceptEdits.label, "Auto-accept edits")
        XCTAssertEqual(PermissionMode.bypassPermissions.label, "Bypass permissions")
        XCTAssertEqual(PermissionMode(rawValue: "read-only").label, "read-only")
        XCTAssertEqual(PermissionMode.known.map(\.rawValue), ["default", "acceptEdits", "bypassPermissions"])
    }

    // MARK: - ProfileInfo: uses capabilities when present, falls back to the current fixed catalog otherwise

    func testProfileWithoutCapabilitiesFallsBackToClaudeCatalog() throws {
        let json = """
        {"name":"work","dir":"/Users/x/.tiny/profiles/work","loggedIn":true,
         "agent":"claude","defaultModel":null,"defaultEffort":null}
        """
        let p = try decoder.decode(ProfileInfo.self, from: Data(json.utf8))
        XCTAssertEqual(p.modelChoices.map(\.id), ModelCatalog.choices)
        XCTAssertEqual(p.effortChoices, EffortCatalog.choices)
        XCTAssertEqual(p.permissionModeChoices.map(\.id), ["default", "acceptEdits", "bypassPermissions"])
        XCTAssertEqual(p.permissionModeChoices.map(\.label), ["Ask first", "Auto-accept edits", "Bypass permissions"])
        XCTAssertTrue(p.supportsUsage)
        XCTAssertEqual(p.agentLabel, "Claude")
    }

    func testProfileDecodesCapabilitiesAndLabelFromServer() throws {
        let json = """
        {"name":"oc","dir":"/Users/x/.tiny/profiles/oc","loggedIn":true,
         "agent":"opencode","label":"OpenCode","defaultModel":null,"defaultEffort":null,
         "capabilities":{
           "models":[{"id":"openai/gpt-5.6","label":"GPT-5.6"},{"id":"google/gemini-3-pro"}],
           "efforts":["low","high"],
           "permissionModes":[{"id":"ask","label":"Ask"},{"id":"auto","label":"Auto-approve"}],
           "features":{"usage":false,"images":true}
         }}
        """
        let p = try decoder.decode(ProfileInfo.self, from: Data(json.utf8))
        XCTAssertEqual(p.modelChoices.map(\.id), ["openai/gpt-5.6", "google/gemini-3-pro"])
        XCTAssertEqual(p.modelChoices[0].displayName, "GPT-5.6")
        XCTAssertEqual(p.modelChoices[1].displayName, "google/gemini-3-pro")   // no label → the id
        XCTAssertEqual(p.effortChoices, ["low", "high"])
        XCTAssertEqual(p.permissionModeChoices.map(\.id), ["ask", "auto"])
        XCTAssertEqual(p.permissionModeChoices.map(\.label), ["Ask", "Auto-approve"])
        XCTAssertFalse(p.supportsUsage)
        XCTAssertEqual(p.agentLabel, "OpenCode")
    }

    func testUnknownAgentWithoutCapabilitiesOffersNoClaudeModels() throws {
        // Claude's fixed model catalog is never offered to non-Claude agents (don't accidentally send claude-* to Codex)
        let json = """
        {"name":"cx","dir":"/d","loggedIn":true,"agent":"codex","defaultModel":null,"defaultEffort":null}
        """
        let p = try decoder.decode(ProfileInfo.self, from: Data(json.utf8))
        XCTAssertTrue(p.modelChoices.isEmpty)
        XCTAssertTrue(p.effortChoices.isEmpty)
        XCTAssertEqual(p.permissionModeChoices.map(\.id), ["default", "acceptEdits", "bypassPermissions"])
        XCTAssertEqual(p.agentLabel, "Codex")
    }

    func testAgentLabelKnownAgentsWithoutServerLabel() {
        func p(_ agent: String?) -> ProfileInfo {
            ProfileInfo(name: "n", dir: "/d", loggedIn: true, agent: agent, defaultModel: nil, defaultEffort: nil)
        }
        XCTAssertEqual(p(nil).agentLabel, "Claude")        // old server
        XCTAssertEqual(p("claude").agentLabel, "Claude")
        XCTAssertEqual(p("codex").agentLabel, "Codex")
        XCTAssertEqual(p("opencode").agentLabel, "OpenCode")
        XCTAssertEqual(p("droid").agentLabel, "droid")     // unknown stays raw, assuming the server provides a label
    }

    // MARK: - Tools: prefer the server's kind / summary, else the current name matching

    func testToolStartedEventCarriesKindAndSummary() throws {
        let json = """
        {"id":1,"sessionId":"s","type":"tool_started","createdAt":"c",
         "payload":{"toolName":"shell_command","toolUseId":"t1","kind":"execute","summary":"ls -la",
                    "input":{"argv":["ls","-la"]}}}
        """
        let ev = try decoder.decode(EventRecord.self, from: Data(json.utf8)).event
        guard case .toolStarted(let name, let useId, let input, let kind, let summary) = ev else {
            return XCTFail("\(ev)")
        }
        XCTAssertEqual(name, "shell_command")
        XCTAssertEqual(useId, "t1")
        XCTAssertEqual(kind, "execute")
        XCTAssertEqual(summary, "ls -la")
        XCTAssertNotNil(input.objectValue?["argv"])
    }

    func testToolStartedEventWithoutHintsHasNilKindAndSummary() throws {
        let json = """
        {"id":1,"sessionId":"s","type":"tool_started","createdAt":"c",
         "payload":{"toolName":"Bash","toolUseId":"t1","input":{"command":"ls"}}}
        """
        let ev = try decoder.decode(EventRecord.self, from: Data(json.utf8)).event
        guard case .toolStarted(_, _, _, let kind, let summary) = ev else { return XCTFail("\(ev)") }
        XCTAssertNil(kind)
        XCTAssertNil(summary)
    }

    func testToolCallKindPrefersServerHintAndLabelPrefersSummary() {
        func call(_ name: String, hint: String?, summary: String? = nil) -> ToolCall {
            ToolCall(id: "t", name: name, input: .object([:]), isError: false, kindHint: hint, summary: summary)
        }
        XCTAssertEqual(call("shell_command", hint: "execute", summary: "ls -la").kind, .command)
        XCTAssertEqual(call("shell_command", hint: "execute", summary: "ls -la").label, "ls -la")
        XCTAssertEqual(call("apply_patch", hint: "edit").kind, .edit)
        XCTAssertEqual(call("rm", hint: "delete").kind, .edit)
        XCTAssertEqual(call("mv", hint: "move").kind, .edit)
        XCTAssertEqual(call("cat", hint: "read").kind, .read)
        XCTAssertEqual(call("rg", hint: "search").kind, .read)
        XCTAssertEqual(call("curl", hint: "fetch").kind, .other)
        XCTAssertEqual(call("plan", hint: "think").kind, .other)
        // Even with a Claude-style name, a hint wins when present
        XCTAssertEqual(call("Bash", hint: "read").kind, .read)
    }

    func testToolCallKindFallsBackToClaudeToolNamesWithoutHint() {
        func call(_ name: String) -> ToolCall {
            ToolCall(id: "t", name: name, input: .object(["command": .string("ls")]), isError: false)
        }
        XCTAssertEqual(call("Bash").kind, .command)
        XCTAssertEqual(call("Bash").label, "ls")
        XCTAssertEqual(call("Edit").kind, .edit)
        XCTAssertEqual(call("Grep").kind, .read)
        XCTAssertEqual(call("mcp__tiny__send_user_file").kind, .send)
        XCTAssertEqual(call("shell_command").kind, .other)
    }

    func testBuildChatItemsPassesKindAndSummaryThrough() {
        let events = [
            EventRecord(id: 1, sessionId: "s", type: "tool_started", payload: .object([
                "toolName": .string("exec"), "toolUseId": .string("t1"),
                "kind": .string("execute"), "summary": .string("pnpm test"),
                "input": .object([:]),
            ]), createdAt: "c"),
        ]
        let items = buildChatItems(events)
        guard case .tools(_, let calls)? = items.first else { return XCTFail("\(items)") }
        XCTAssertEqual(calls[0].kind, .command)
        XCTAssertEqual(calls[0].label, "pnpm test")
        XCTAssertEqual(toolGroupSummary(calls), "Ran 1 command")
    }

    // MARK: - Permissions: kind / summary are optional. Question detection may use either the name or the kind

    func testPendingPermissionDecodesOptionalKindAndSummary() throws {
        let old = """
        {"id":"r1","sessionId":"s","toolName":"Bash","input":{"command":"ls"},"requestedAt":"t"}
        """
        let p0 = try decoder.decode(PendingPermission.self, from: Data(old.utf8))
        XCTAssertNil(p0.kind)
        XCTAssertNil(p0.summary)
        XCTAssertFalse(p0.isQuestion)

        let new = """
        {"id":"r2","sessionId":"s","toolName":"commandExecution","kind":"execute","summary":"rm -rf build",
         "input":{"command":"rm -rf build"},"requestedAt":"t"}
        """
        let p1 = try decoder.decode(PendingPermission.self, from: Data(new.utf8))
        XCTAssertEqual(p1.kind, "execute")
        XCTAssertEqual(p1.summary, "rm -rf build")
        XCTAssertFalse(p1.isQuestion)
    }

    func testIsQuestionByNameOrByKind() throws {
        let questions: JSONValue = .object(["questions": .array([
            .object(["question": .string("Color?"), "options": .array([
                .object(["label": .string("Red"), "description": .string("")]),
            ])]),
        ])])
        let byName = PendingPermission(id: "a", sessionId: "s", toolName: "AskUserQuestion",
                                       input: questions, requestedAt: "t")
        XCTAssertTrue(byName.isQuestion)
        let byKind = PendingPermission(id: "b", sessionId: "s", toolName: "request_user_input",
                                       input: questions, requestedAt: "t", kind: "question", summary: nil)
        XCTAssertTrue(byKind.isQuestion)
        // Even with kind question, an unreadable shape falls back to the plain permission banner
        let broken = PendingPermission(id: "c", sessionId: "s", toolName: "request_user_input",
                                       input: .object(["prompt": .string("?")]), requestedAt: "t",
                                       kind: "question", summary: nil)
        XCTAssertFalse(broken.isQuestion)
    }

    // MARK: - The common question shape (text / multi / string options) also reads into the same AskQuestion as the Claude shape

    func testAskUserQuestionParsesCommonShape() throws {
        let input = try decoder.decode(JSONValue.self, from: Data("""
        {"questions":[{"text":"Which color?","options":["Red","Blue"],"multi":true,"allowOther":true},
                      {"text":"Deploy?","options":[{"label":"Yes","description":"Ship it"},"No"]}]}
        """.utf8))
        let qs = AskUserQuestion.parse(input)
        XCTAssertEqual(qs.count, 2)
        XCTAssertEqual(qs[0].question, "Which color?")
        XCTAssertTrue(qs[0].multiSelect)
        XCTAssertEqual(qs[0].options.map(\.label), ["Red", "Blue"])
        XCTAssertEqual(qs[0].options.map(\.description), ["", ""])
        XCTAssertEqual(qs[1].question, "Deploy?")
        XCTAssertFalse(qs[1].multiSelect)
        XCTAssertEqual(qs[1].options.map(\.label), ["Yes", "No"])
        XCTAssertEqual(qs[1].options[0].description, "Ship it")
    }

    // MARK: - Demo mode carries a second agent's profile (for reviewers and screenshots)

    func testDemoProfilesIncludeASecondAgent() async throws {
        let profiles = try await DemoBackend().profiles()
        XCTAssertGreaterThanOrEqual(profiles.count, 2)
        XCTAssertEqual(Set(profiles.compactMap(\.agent)).count, profiles.count, "agents should differ")
        XCTAssertTrue(profiles.contains { $0.agent == "claude" })
        let second = try XCTUnwrap(profiles.first { $0.agent != "claude" })
        XCTAssertTrue(second.loggedIn)
        XCTAssertFalse(second.modelChoices.isEmpty, "second agent must ship its own model list via capabilities")
        XCTAssertNotEqual(second.agentLabel, "Claude")
    }
}
