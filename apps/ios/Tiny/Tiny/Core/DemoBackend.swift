import Foundation

/// Demo mode for App Store review. Reviewers have no Mac + tinyd, so let them
/// exercise the whole UI with mock sessions (a design-spec requirement).
/// Uses no network at all.
/// All mutable state is serialized through the queue, hence @unchecked Sendable
/// (it gets captured by @Sendable closures such as AsyncStream's onTermination).
final class DemoBackend: TinyBackend, @unchecked Sendable {
    let isDemo = true
    static let demoFileId = "demo-file-1"

    private let sessionId = "demo-session-1"
    private var nextEventId: Int
    private var storedEvents: [EventRecord]
    private var pending: [PendingPermission] = []
    private var continuations: [UUID: AsyncStream<EventRecord>.Continuation] = [:]
    private var session: SessionRecord
    private var archivedIds: Set<String> = []
    private let queue = DispatchQueue(label: "demo-backend")

    init() {
        let now = ISO8601DateFormatter().string(from: Date())
        session = SessionRecord(
            id: sessionId, agentSessionId: "demo-agent", agent: "claude", profile: "demo",
            cwd: "/Users/you/src/my-app", permissionMode: .default, model: nil, effort: nil,
            title: "Demo: fix a bug", status: .idle, createdAt: now, updatedAt: now)
        var id = 0
        func ev(_ type: String, _ payload: JSONValue) -> EventRecord {
            id += 1
            return EventRecord(id: id, sessionId: "demo-session-1", type: type,
                               payload: payload, createdAt: now)
        }
        storedEvents = [
            ev("turn_started", .object(["agentSessionId": .string("demo-agent")])),
            ev("assistant_text", .object(["text": .string("I'll look into the failing test in my-app. Let me run the tests first to find where it's failing.")])),
            ev("tool_started", .object(["toolName": .string("Bash"), "toolUseId": .string("t1"),
                                        "input": .object(["command": .string("npm test")])])),
            ev("tool_finished", .object(["toolUseId": .string("t1"), "isError": .bool(false)])),
            ev("assistant_text", .object(["text": .string("It was a boundary condition in date-utils.ts. I fixed it and confirmed the tests pass. Sending you a report.")])),
            ev("file_sent", .object(["fileId": .string(Self.demoFileId), "mime": .string("text/html"),
                                     "caption": .string("Fix report"),
                                     "name": .string("/Users/you/src/my-app/report.html")])),
            ev("turn_completed", .object(["costUsd": .number(0.12), "resultText": .string("Fixed: corrected a boundary condition in date-utils.ts"), "contextTokens": .number(48_000)])),
        ]
        nextEventId = id
    }

    private func emit(_ type: String, _ payload: JSONValue) {
        queue.sync {
            nextEventId += 1
            let ev = EventRecord(id: nextEventId, sessionId: sessionId, type: type, payload: payload,
                                 createdAt: ISO8601DateFormatter().string(from: Date()))
            storedEvents.append(ev)
            // A consumer that leaves `for await` via break sometimes never fires
            // onTermination, so check yield's return value and sweep the dictionary ourselves.
            var terminatedKeys: [UUID] = []
            for (key, c) in continuations {
                if case .terminated = c.yield(ev) {
                    terminatedKeys.append(key)
                }
            }
            for key in terminatedKeys { continuations.removeValue(forKey: key) }
        }
    }

    func profiles() async throws -> [ProfileInfo] {
        [
            ProfileInfo(name: "demo", dir: "/Users/you/.tiny/profiles/demo", loggedIn: true,
                        agent: "claude", defaultModel: nil, defaultEffort: nil),
            // The second agent (for reviewers and screenshots). Choices carried in the same capabilities shape the server serves
            ProfileInfo(name: "demo-codex", dir: "/Users/you/.tiny/profiles/demo-codex", loggedIn: true,
                        agent: "codex", defaultModel: nil, defaultEffort: nil, label: "Codex",
                        capabilities: AgentCapabilities(
                            models: [ModelChoice(id: "gpt-5.6-terra", label: "GPT-5.6 Terra"),
                                     ModelChoice(id: "gpt-5.6-mini", label: "GPT-5.6 mini")],
                            efforts: ["low", "medium", "high", "xhigh"],
                            permissionModes: [
                                PermissionModeChoice(id: "ask", label: "Ask first"),
                                PermissionModeChoice(id: "auto-edit", label: "Auto-accept edits"),
                                PermissionModeChoice(id: "bypass", label: "Bypass approvals and sandbox"),
                            ],
                            features: AgentFeatures(images: true, usage: true, questions: true,
                                                    attach: true, interrupt: true))),
        ]
    }
    func sessions() async throws -> [SessionRecord] {
        queue.sync { archivedIds.contains(session.id) ? [] : [session] }
    }
    func archivedSessions() async throws -> [SessionRecord] {
        queue.sync { archivedIds.contains(session.id) ? [session] : [] }
    }
    func recentCwds() async throws -> [String] { [session.cwd] }
    func setArchived(sessionId: String, archived: Bool) async throws -> SessionRecord {
        queue.sync {
            if archived { archivedIds.insert(sessionId) } else { archivedIds.remove(sessionId) }
            return session
        }
    }
    func profileUsage(name: String) async throws -> ProfileUsage {
        ProfileUsage(profile: name, limits: [
            UsageLimit(kind: "session", label: "Session (5h)", percent: 34,
                       resetsAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600 * 2))),
            UsageLimit(kind: "weekly_all", label: "Weekly (all models)", percent: 12,
                       resetsAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600 * 24 * 4))),
        ], fetchedAt: ISO8601DateFormatter().string(from: Date()))
    }
    func createSession(profile: String, cwd: String, permissionMode: PermissionMode, model: String?, effort: String?) async throws -> SessionRecord {
        session   // demo returns the existing session (the UI explains that creating one needs a Mac)
    }
    func events(sessionId: String, since: Int) async throws -> [EventRecord] {
        queue.sync { storedEvents.filter { $0.id > since } }
    }

    func sendTurn(sessionId: String, prompt: String, images: [TurnImageAttachment]) async throws {
        var payload: [String: JSONValue] = ["text": .string(prompt)]
        if !images.isEmpty { payload["imageCount"] = .number(Double(images.count)) }
        emit("user_message", .object(payload))
        emit("turn_started", .object(["agentSessionId": .string("demo-agent")]))
        Task {
            try? await Task.sleep(nanoseconds: 800_000_000)
            // Prompts containing "build" reproduce the permission flow
            if prompt.lowercased().contains("build") {
                let reqId = UUID().uuidString
                self.queue.sync {
                    self.pending = [PendingPermission(
                        id: reqId, sessionId: self.sessionId, toolName: "Bash",
                        input: .object(["command": .string("npm run build")]),
                        requestedAt: ISO8601DateFormatter().string(from: Date()))]
                }
                self.emit("permission_requested", .object([
                    "reqId": .string(reqId), "toolName": .string("Bash"),
                    "input": .object(["command": .string("npm run build")])]))
            } else if prompt.lowercased().contains("questions") {
                // Plural: a three-question set, which is what exercises the carousel
                let reqId = UUID().uuidString
                func q(_ text: String, _ header: String, _ a: String, _ b: String) -> JSONValue {
                    .object([
                        "question": .string(text), "header": .string(header), "multiSelect": .bool(false),
                        "options": .array([
                            .object(["label": .string(a), "description": .string("")]),
                            .object(["label": .string(b), "description": .string("")]),
                        ]),
                    ])
                }
                // The last one is deliberately long: a question taller than the card has to scroll
                // inside it rather than push the buttons off screen
                let long: JSONValue = .object([
                    "question": .string("Who reviews it?"), "header": .string("Review"),
                    "multiSelect": .bool(false),
                    "options": .array([
                        .object(["label": .string("You"),
                                 "description": .string("You read the diff yourself before it ships, the way you would review a teammate's branch.")]),
                        .object(["label": .string("A teammate"),
                                 "description": .string("Hand it to whoever owns the module and wait for their pass before merging anything.")]),
                        .object(["label": .string("Both of us"),
                                 "description": .string("You read it first, then a second pair of eyes goes over the parts that touch the data model.")]),
                        .object(["label": .string("Nobody"),
                                 "description": .string("Ship it and rely on the tests; anything that slips through gets fixed in the next pass.")]),
                    ]),
                ])
                let input: JSONValue = .object(["questions": .array([
                    q("Which approach should I take?", "Approach", "Quick fix", "Refactor"),
                    q("Where should it ship?", "Target", "Staging", "Production"),
                    long,
                ])])
                self.queue.sync {
                    self.pending = [PendingPermission(
                        id: reqId, sessionId: self.sessionId, toolName: "AskUserQuestion",
                        input: input,
                        requestedAt: ISO8601DateFormatter().string(from: Date()))]
                }
                self.emit("permission_requested", .object([
                    "reqId": .string(reqId), "toolName": .string("AskUserQuestion"), "input": input]))
            } else if prompt.lowercased().contains("question") {
                // Prompts containing "question" reproduce AskUserQuestion (a multiple-choice question)
                let reqId = UUID().uuidString
                let input: JSONValue = .object([
                    "questions": .array([.object([
                        "question": .string("Which approach should I take?"),
                        "header": .string("Approach"),
                        "multiSelect": .bool(false),
                        "options": .array([
                            .object(["label": .string("Quick fix"),
                                     "description": .string("Patch the symptom now, refactor later.")]),
                            .object(["label": .string("Refactor"),
                                     "description": .string("Restructure the module properly.")]),
                        ]),
                    ])]),
                ])
                self.queue.sync {
                    self.pending = [PendingPermission(
                        id: reqId, sessionId: self.sessionId, toolName: "AskUserQuestion",
                        input: input,
                        requestedAt: ISO8601DateFormatter().string(from: Date()))]
                }
                self.emit("permission_requested", .object([
                    "reqId": .string(reqId), "toolName": .string("AskUserQuestion"), "input": input]))
            } else {
                self.emit("assistant_text", .object(["text": .string("(Demo) Got your message: \"\(prompt)\". In the real app, Claude Code on your Mac would do the work here.")]))
                try? await Task.sleep(nanoseconds: 600_000_000)
                self.emit("turn_completed", .object(["costUsd": .number(0.05), "resultText": .string("Demo turn completed"), "contextTokens": .number(52_000)]))
            }
        }
    }

    func interrupt(sessionId: String) async throws {
        emit("turn_failed", .object(["error": .string("interrupted")]))
    }

    func updateSession(sessionId: String, model: String?, permissionMode: PermissionMode?, effort: String?, title: String?) async throws -> SessionRecord {
        session   // unchanged in demo
    }

    func setDetached(sessionId: String, detached: Bool) async throws {
        emit("session_state_changed", .object(["status": .string(detached ? "detached" : "idle")]))
    }

    func pendingPermissions(sessionId: String) async throws -> [PendingPermission] {
        queue.sync { pending }
    }

    func answerCliQuestion(sessionId: String, toolUseId: String, answers: [String: String]) async throws {
        emit("cli_question_answered", .object([
            "toolUseId": .string(toolUseId),
            "answers": .object(answers.mapValues { .string($0) }),
        ]))
        let chosen = answers.values.sorted().joined(separator: ", ")
        emit("assistant_text", .object(["text": .string("(Demo) Got it — you chose: \(chosen).")]))
        emit("turn_completed", .object(["costUsd": .number(0.01), "resultText": .string("Demo question answered")]))
    }

    func respondPermission(reqId: String, allow: Bool, message: String?, updatedInput: JSONValue?) async throws {
        let resolved = queue.sync { () -> PendingPermission? in
            let p = pending.first { $0.id == reqId }
            pending.removeAll { $0.id == reqId }
            return p
        }
        var resolvedPayload: [String: JSONValue] = ["reqId": .string(reqId),
                                                    "behavior": .string(allow ? "allow" : "deny")]
        if allow, let answers = updatedInput?.objectValue?["answers"] {
            resolvedPayload["answers"] = answers   // like the real server, answers go into the history event
        }
        emit("permission_resolved", .object(resolvedPayload))
        if resolved?.toolName == "AskUserQuestion" {
            // Echo the chosen answer and close the turn
            let answers = updatedInput?.objectValue?["answers"]?.objectValue ?? [:]
            let chosen = answers.values.compactMap(\.stringValue).joined(separator: ", ")
            emit("assistant_text", .object(["text": .string(
                allow ? "(Demo) Got it — you chose: \(chosen.isEmpty ? "(no answer)" : chosen)."
                      : "(Demo) No problem, I'll decide on my own.")]))
            emit("turn_completed", .object(["costUsd": .number(0.01),
                                            "resultText": .string("Demo question answered")]))
        } else if allow {
            Task {
                self.emit("tool_started", .object(["toolName": .string("Bash"), "toolUseId": .string("t9"),
                                                   "input": .object(["command": .string("npm run build")])]))
                try? await Task.sleep(nanoseconds: 900_000_000)
                self.emit("tool_finished", .object(["toolUseId": .string("t9"), "isError": .bool(false)]))
                self.emit("turn_completed", .object(["costUsd": .number(0.08),
                                                     "resultText": .string("Build succeeded")]))
            }
        } else {
            emit("turn_completed", .object(["costUsd": .null, "resultText": .string("Stopped because permission was denied")]))
        }
    }

    func fileData(fileId: String) async throws -> (data: Data, mime: String) {
        let html = """
        <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <body style="font-family:-apple-system;padding:24px;background:#111;color:#eee">
        <h1>Fix Report (Demo)</h1>
        <p>Fixed a boundary condition bug in date-utils.ts.</p>
        <pre style="background:#222;padding:12px;border-radius:8px">- if (d > end)\n+ if (d >= end)</pre>
        <p>Tests: 42 passed / 0 failed</p></body>
        """
        return (Data(html.utf8), "text/html")
    }

    func eventStream(sessionId: String, since: Int) -> AsyncStream<EventRecord> {
        AsyncStream { continuation in
            let key = UUID()
            queue.sync {
                for ev in storedEvents where ev.id > since { continuation.yield(ev) }
                continuations[key] = continuation
            }
            continuation.onTermination = { [weak self] _ in
                self?.queue.sync { _ = self?.continuations.removeValue(forKey: key) }
            }
        }
    }
}
