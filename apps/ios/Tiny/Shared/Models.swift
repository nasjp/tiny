import Foundation

// MARK: - Arbitrary JSON (for tool_started.input / PendingPermission.input)

enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    var stringValue: String? { if case .string(let v) = self { return v }; return nil }
    var objectValue: [String: JSONValue]? { if case .object(let v) = self { return v }; return nil }

    /// Formatting for UI display (tool argument preview)
    var displayText: String {
        switch self {
        case .string(let v): return v
        case .number(let v): return v == v.rounded() ? String(Int(v)) : String(v)
        case .bool(let v): return String(v)
        case .null: return "null"
        case .array(let v): return "[" + v.map(\.displayText).joined(separator: ", ") + "]"
        case .object(let v):
            return v.sorted { $0.key < $1.key }
                .map { "\($0.key): \($0.value.displayText)" }.joined(separator: "\n")
        }
    }
}

// MARK: - Sessions

enum SessionStatus: String, Codable {
    case idle, running, detached, interrupted
}

/// Permission mode. A closed enum would make the whole session-list decode fail the moment
/// the server (future Codex / OpenCode etc.) returns an unknown value, so this is
/// 3 known values + raw string. On the wire it stays a plain string ("default" etc.).
struct PermissionMode: RawRepresentable, Codable, Hashable {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }

    static let `default` = PermissionMode(rawValue: "default")
    static let acceptEdits = PermissionMode(rawValue: "acceptEdits")
    static let bypassPermissions = PermissionMode(rawValue: "bypassPermissions")
    /// Claude's 3 modes (default choices for profiles without capabilities)
    static let known: [PermissionMode] = [.default, .acceptEdits, .bypassPermissions]

    var label: String {
        switch rawValue {
        case "default": return "Ask first"
        case "acceptEdits": return "Auto-accept edits"
        case "bypassPermissions": return "Bypass permissions"
        default: return rawValue
        }
    }

    init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// The turn in progress on a session, whichever side started it (a turn sent from the phone, one
/// typed into the CLI, one another session sent there). Runtime-only on the server: exactly as
/// fresh as the last poll. Older servers omit the key
struct SessionActivity: Codable, Hashable {
    /// When the work started (ISO 8601). nil = the server could not tell
    var since: String? = nil
    /// Output tokens the agent has produced so far in this turn. nil = unknown
    var outputTokens: Int? = nil
}

struct SessionRecord: Codable, Identifiable, Hashable {
    let id: String
    let agentSessionId: String?
    let agent: String
    let profile: String
    let cwd: String
    let permissionMode: PermissionMode
    let model: String?     // claude model; nil = CLI default
    let effort: String?    // reasoning effort (low/medium/high/xhigh/max); nil = default
    let title: String?
    let status: SessionStatus
    let createdAt: String
    let updatedAt: String
    var archivedAt: String? = nil   // archive time (ISO); nil = shown normally; older servers omit the key

    /// true = the agent's own CLI still has this session open. nil = the server could not tell
    /// (or is older than this feature). Older servers omit the key.
    var cliLive: Bool? = nil

    /// true = a turn sent now runs inside that CLI (live join), so the session behaves like any other
    /// from here. Older servers omit the key.
    var cliJoin: Bool? = nil

    /// Only a definite "live and NOT joinable" locks the composer (and shows the CLI badge / note).
    /// "Cannot tell" must not take the session away, and a joinable session is not the user's concern
    var isHeldByCLI: Bool { cliLive == true && cliJoin != true }

    /// What the server knows is running right now (nil = idle, or an older server)
    var activity: SessionActivity? = nil

    /// Something is running on this session — a turn tiny runs (status) or one the CLI is running
    /// on its own (activity). Who started it makes no difference to how it is shown
    var isBusy: Bool { status == .running || activity != nil }

    var displayTitle: String { title ?? (cwd as NSString).lastPathComponent }
}

/// Model choice handed out by the server (without a label, the id is shown as-is)
struct ModelChoice: Codable, Hashable, Identifiable {
    let id: String
    var label: String? = nil
    var displayName: String { label ?? id }
}

/// Permission-mode choice handed out by the server (the id is sent verbatim as permissionMode)
struct PermissionModeChoice: Codable, Hashable, Identifiable {
    let id: String
    let label: String
    var description: String? = nil
}

struct AgentFeatures: Codable, Hashable {
    var images: Bool? = nil
    var usage: Bool? = nil
    var questions: Bool? = nil
    var attach: Bool? = nil
    var interrupt: Bool? = nil
}

/// Per-profile (= per-agent) choices, returned by the server. Missing items fall back to app-side defaults
struct AgentCapabilities: Codable, Hashable {
    var models: [ModelChoice]? = nil
    var efforts: [String]? = nil
    var permissionModes: [PermissionModeChoice]? = nil
    var features: AgentFeatures? = nil
}

struct ProfileInfo: Codable, Identifiable, Hashable {
    let name: String
    let dir: String
    let loggedIn: Bool
    let agent: String?           // "claude" / "codex" / "opencode" …; nil on older servers
    let defaultModel: String?    // model from settings.json; nil = CLI picks automatically
    let defaultEffort: String?   // effort from settings.json; nil = CLI default
    /// Display name (handed out by the server). Falls back to deriving from agent
    var label: String? = nil
    /// Choices (handed out by the server). Falls back to Claude's fixed catalog or empty
    var capabilities: AgentCapabilities? = nil
    var id: String { name }

    private var isClaude: Bool { agent == nil || agent == "claude" }

    /// Agent name for display. Server label > known agent > raw value
    var agentLabel: String {
        if let label, !label.isEmpty { return label }
        switch agent {
        case "claude", nil: return "Claude"
        case "codex": return "Codex"
        case "opencode": return "OpenCode"
        case .some(let other): return other
        }
    }

    /// Model choices. Claude's fixed catalog is never shown for non-Claude agents (never send claude-* to another agent)
    var modelChoices: [ModelChoice] {
        if let models = capabilities?.models { return models }
        return isClaude ? ModelCatalog.choices.map { ModelChoice(id: $0) } : []
    }

    var effortChoices: [String] {
        if let efforts = capabilities?.efforts { return efforts }
        return isClaude ? EffortCatalog.choices : []
    }

    /// Permission-mode choices. Falls back to Claude's 3 modes (for both old servers and unknown agents)
    var permissionModeChoices: [PermissionModeChoice] {
        if let modes = capabilities?.permissionModes { return modes }
        return PermissionMode.known.map { PermissionModeChoice(id: $0.rawValue, label: $0.label) }
    }

    /// Whether to show on the Usage screen (shown unless the server says false)
    var supportsUsage: Bool { capabilities?.features?.usage ?? true }
}

// MARK: - Events

struct EventRecord: Codable, Identifiable {
    let id: Int
    let sessionId: String
    let type: String
    let payload: JSONValue
    let createdAt: String

    var event: TinyEvent { TinyEvent(type: type, payload: payload) }
}

/// Model choices. Always full IDs (with aliases you can't tell what actually ran).
/// When a new model ships, add one line here
/// Reasoning-effort choices (same as the SDK's EffortLevel)
enum EffortCatalog {
    static let choices: [String] = ["low", "medium", "high", "xhigh", "max"]
}

enum ModelCatalog {
    static let choices: [String] = [
        "claude-fable-5",
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-haiku-4-5-20251001",
    ]
}

/// Image attached to a turn. mediaType is limited to the 4 types the server accepts
struct TurnImageAttachment: Equatable {
    let data: Data
    let mediaType: String
}

enum TinyEvent: Equatable {
    // imageFileIds are the outbox fileIds of attached images (used for thumbnails in history).
    // Events from older servers lack them; in that case we fall back to showing the imageCount
    case userMessage(text: String, imageCount: Int, imageFileIds: [String])
    case turnStarted(agentSessionId: String)
    case assistantText(String)
    /// The model's progress narration — what Claude Code's terminal shows as a summarized thinking line
    case assistantThinking(String)
    // kind / summary are display hints attached by the server (ACP ToolKind vocabulary: read / edit /
    // delete / move / search / execute / think / fetch / other, plus a one-line summary). nil on older servers
    case toolStarted(toolName: String, toolUseId: String, input: JSONValue, kind: String?, summary: String?)
    /// output = what the tool printed, as the agent saw it (nil on older servers or when nothing was recorded);
    /// truncated = the server kept only the head of a long output
    case toolFinished(toolUseId: String, isError: Bool, output: String?, truncated: Bool)
    case turnCompleted(costUsd: Double?, resultText: String?, contextTokens: Int?)
    case turnFailed(reason: String)
    case authError(String)
    case permissionRequested(reqId: String, toolName: String, input: JSONValue)
    // answers are AskUserQuestion responses (so history can show what was chosen). nil for ordinary permissions
    case permissionResolved(reqId: String, behavior: String, answers: [String: String]?)
    case fileSent(fileId: String, mime: String, caption: String?, name: String)
    case sessionStateChanged(status: String)
    /// The CLI that owns a live turn is waiting for its user (a permission prompt in the terminal)
    case cliAttention(reason: String)
    /// A question the CLI asked its person (AskUserQuestion in a session tiny does not drive).
    /// Read-only on the phone: only the CLI can answer it
    case cliQuestion(toolUseId: String, input: JSONValue)
    /// That question's outcome: the chosen answers keyed by question text, empty when it was
    /// dismissed in the CLI
    case cliQuestionAnswered(toolUseId: String, answers: [String: String], rejected: Bool)
    /// A message another Claude session sent into this one (agent teams, SendMessage between
    /// terminals). The server already unwrapped Claude Code's XML: `from` names the sender
    case peerMessage(from: String, summary: String?, text: String)
    case unknown(type: String)

    init(type: String, payload: JSONValue) {
        let p = payload.objectValue ?? [:]
        func str(_ k: String) -> String? { p[k]?.stringValue }
        switch type {
        case "user_message":
            let count = { if case .number(let n) = p["imageCount"] { return Int(n) }; return 0 }()
            let ids: [String] = {
                if case .array(let a) = p["imageFileIds"] { return a.compactMap(\.stringValue) }
                return []
            }()
            self = .userMessage(text: str("text") ?? "", imageCount: count, imageFileIds: ids)
        case "turn_started":
            self = .turnStarted(agentSessionId: str("agentSessionId") ?? "")
        case "assistant_text":
            self = .assistantText(str("text") ?? "")
        case "assistant_thinking":
            self = .assistantThinking(str("text") ?? "")
        case "tool_started":
            self = .toolStarted(toolName: str("toolName") ?? "a tool",
                                toolUseId: str("toolUseId") ?? "",
                                input: p["input"] ?? .null,
                                kind: str("kind"), summary: str("summary"))
        case "tool_finished":
            let isError = { if case .bool(let b) = p["isError"] { return b }; return false }()
            let truncated = { if case .bool(let b) = p["truncated"] { return b }; return false }()
            self = .toolFinished(toolUseId: str("toolUseId") ?? "", isError: isError,
                                 output: str("output"), truncated: truncated)
        case "turn_completed":
            let cost = { if case .number(let n) = p["costUsd"] { return n as Double? }; return nil }()
            let ctx = { if case .number(let n) = p["contextTokens"] { return Int(n) as Int? }; return nil }()
            self = .turnCompleted(costUsd: cost, resultText: str("resultText"), contextTokens: ctx)
        case "turn_failed":
            // payload comes in 2 shapes: {subtype} (SDK non-success) / {error} (exception / interrupt)
            self = .turnFailed(reason: str("error") ?? str("subtype") ?? "unknown")
        case "auth_error":
            self = .authError(str("error") ?? "authentication error")
        case "permission_requested":
            self = .permissionRequested(reqId: str("reqId") ?? "", toolName: str("toolName") ?? "a tool",
                                        input: p["input"] ?? .null)
        case "permission_resolved":
            let answers: [String: String]? = {
                guard let obj = p["answers"]?.objectValue else { return nil }
                let m = obj.compactMapValues(\.stringValue)
                return m.isEmpty ? nil : m
            }()
            self = .permissionResolved(reqId: str("reqId") ?? "", behavior: str("behavior") ?? "",
                                       answers: answers)
        case "file_sent":
            self = .fileSent(fileId: str("fileId") ?? "", mime: str("mime") ?? "application/octet-stream",
                             caption: str("caption"), name: str("name") ?? "")
        case "session_state_changed":
            self = .sessionStateChanged(status: str("status") ?? "")
        case "cli_attention":
            self = .cliAttention(reason: str("reason") ?? "input")
        case "cli_question":
            self = .cliQuestion(toolUseId: str("toolUseId") ?? "", input: p["input"] ?? .null)
        case "cli_question_answered":
            let answers = p["answers"]?.objectValue?.compactMapValues(\.stringValue) ?? [:]
            let rejected = { if case .bool(let b) = p["rejected"] { return b }; return false }()
            self = .cliQuestionAnswered(toolUseId: str("toolUseId") ?? "", answers: answers, rejected: rejected)
        case "peer_message":
            self = .peerMessage(from: str("from") ?? "another session", summary: str("summary"),
                                text: str("text") ?? "")
        default:
            self = .unknown(type: type)
        }
    }
}

// MARK: - Permissions

struct PendingPermission: Codable, Identifiable {
    let id: String            // = reqId (the REST key name is id)
    let sessionId: String
    let toolName: String
    let input: JSONValue
    let requestedAt: String
    /// Server display hints (same vocabulary as tool_started). nil on older servers
    var kind: String? = nil
    var summary: String? = nil

    /// Whether to treat this as a multiple-choice question (name is AskUserQuestion, or the server
    /// says kind=question, and the shape is parseable). Unparseable shapes fall back to the ordinary permission banner
    var isQuestion: Bool {
        (toolName == "AskUserQuestion" || kind == "question") && !AskUserQuestion.parse(input).isEmpty
    }
}

// MARK: - AskUserQuestion (multiple-choice question; arrives via the permission flow)

struct AskOption: Equatable {
    let label: String
    let description: String
}

struct AskQuestion: Equatable {
    let question: String
    let header: String
    let multiSelect: Bool
    let options: [AskOption]
}

/// Conversion to/from the SDK's AskUserQuestionInput. Contract (sdk-tools.d.ts):
/// - input.questions = [{question, header, options: [{label, description}], multiSelect}]
/// - the allow response returns updatedInput with answers = {question text: chosen label}
///   (multi-select joins with commas; free-form input is passed through as the answer string)
/// The common shape for other agents (converted and delivered by the server) is read by the same function:
/// - questions = [{text, options: [string | {label, description}], multi, allowOther}]
enum AskUserQuestion {
    /// Returns an empty array for unexpected shapes (callers fall back to the ordinary permission banner)
    static func parse(_ input: JSONValue) -> [AskQuestion] {
        guard case .array(let items)? = input.objectValue?["questions"] else { return [] }
        return items.compactMap { item in
            guard let o = item.objectValue,
                  let question = o["question"]?.stringValue ?? o["text"]?.stringValue,
                  case .array(let rawOptions)? = o["options"] else { return nil }
            let options = rawOptions.compactMap { opt -> AskOption? in
                if let label = opt.stringValue { return AskOption(label: label, description: "") }
                guard let oo = opt.objectValue, let label = oo["label"]?.stringValue else { return nil }
                return AskOption(label: label, description: oo["description"]?.stringValue ?? "")
            }
            guard !options.isEmpty else { return nil }
            let multi = {
                if case .bool(let b)? = o["multiSelect"] { return b }
                if case .bool(let b)? = o["multi"] { return b }
                return false
            }()
            return AskQuestion(question: question, header: o["header"]?.stringValue ?? "",
                               multiSelect: multi, options: options)
        }
    }

    /// Builds updatedInput by writing the answers into the original input
    static func updatedInput(original: JSONValue, answers: [String: String]) -> JSONValue {
        var obj = original.objectValue ?? [:]
        obj["answers"] = .object(answers.mapValues { .string($0) })
        return .object(obj)
    }
}

// MARK: - Usage (equivalent of Claude Code's /usage)

struct UsageLimit: Codable, Identifiable, Equatable {
    let kind: String
    let label: String
    let percent: Double
    let resetsAt: String?
    var id: String { kind + label }
}

struct ProfileUsage: Codable, Equatable {
    let profile: String
    let limits: [UsageLimit]
    let fetchedAt: String
}

// MARK: - Pairing

struct PairResponse: Codable {
    let deviceId: String
    let bearerToken: String
    let e2eKey: String
}

struct PairQR: Codable, Equatable {
    let url: String
    let code: String

    /// The QR payload is a raw JSON string (not URL-formatted)
    static func parse(_ raw: String) -> PairQR? {
        guard let data = raw.data(using: .utf8),
              let qr = try? JSONDecoder().decode(PairQR.self, from: data),
              !qr.url.isEmpty, !qr.code.isEmpty else { return nil }
        return qr
    }
}

// MARK: - Push (source of truth: docs/PUSH-PAYLOAD.md)

struct PushIntent: Codable {
    let v: Int
    let type: String          // permission_requested / turn_completed / turn_failed / auth_error / session_added
    let sessionId: String
    let eventId: Int
    let title: String
    let body: String
    let category: String      // tiny.permission / tiny.info
    let level: String         // time-sensitive / active
    let reqId: String?
}
