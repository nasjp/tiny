import SwiftUI

// Match the tool display of the official Claude Code app (Remote Control):
// in chat, consecutive tool calls collapse into a one-line summary; tapping opens
// a sheet showing them one by one (icon + Ran/Edited + description).

/// Display info for one tool call
struct ToolCall: Identifiable, Equatable {
    let id: String
    let name: String
    let input: JSONValue
    var isError: Bool
    /// Server display hints (the ACP ToolKind vocabulary and a one-line summary). When present, they win over name matching
    var kindHint: String? = nil
    var summary: String? = nil
    /// What the tool printed (tool_finished.output). nil = not recorded (older tinyd, or the call is still running)
    var output: String? = nil
    /// The server kept only the head of the output
    var outputTruncated: Bool = false

    /// Leading verb (matches the Claude Code app's wording)
    var verb: String {
        switch kind {
        case .edit: return "Edited"
        case .read: return "Read"
        default: return "Ran"
        }
    }

    var iconName: String {
        switch kind {
        case .command: return "terminal"
        case .edit: return "pencil"
        case .read: return "doc.text"
        case .send: return "square.and.arrow.up"
        case .other: return "wrench.fill"
        }
    }

    /// Display label: the server summary if present; otherwise for Bash the description (falling back to the command), for file tools the basename
    var label: String {
        if let summary, !summary.isEmpty { return summary }
        let obj = input.objectValue ?? [:]
        switch kind {
        case .command:
            return obj["description"]?.stringValue ?? obj["command"]?.stringValue ?? name
        case .edit, .read:
            if let path = obj["file_path"]?.stringValue ?? obj["path"]?.stringValue {
                return (path as NSString).lastPathComponent
            }
            return name
        case .send:
            if let path = obj["path"]?.stringValue {
                return "Sent: \((path as NSString).lastPathComponent)"
            }
            return "Sent a file"
        case .other:
            return name
        }
    }

    enum Kind { case command, edit, read, send, other }

    /// The input, laid out for the detail screen: the fields a person wants to read first (a command,
    /// a file path, the text an edit replaces) and then everything else the call carried
    var inputFields: [ToolInputField] {
        guard let obj = input.objectValue else {
            return input == .null ? [] : [ToolInputField(label: "Input", text: input.prettyText)]
        }
        // Keys shown first, with their labels; the rest follow in key order
        let preferred: [(key: String, label: String)] = switch kind {
        case .command: [("command", "Command"), ("description", "Description")]
        case .edit, .read: [("file_path", "File"), ("path", "File"), ("old_string", "Replace"), ("new_string", "With"), ("content", "Content")]
        default: []
        }
        var fields: [ToolInputField] = []
        var used = Set<String>()
        for (key, label) in preferred {
            guard let v = obj[key] else { continue }
            used.insert(key)
            fields.append(ToolInputField(label: label, text: v.stringValue ?? v.prettyText))
        }
        for key in obj.keys.sorted() where !used.contains(key) {
            let v = obj[key]!
            fields.append(ToolInputField(label: key, text: v.stringValue ?? v.prettyText))
        }
        return fields
    }

    var kind: Kind {
        // Use the server's kind (ACP vocabulary) if present; no need to know per-agent tool names
        switch kindHint {
        case "execute": return .command
        case "edit", "delete", "move": return .edit
        case "read", "search": return .read
        case "think", "fetch", "other": return .other
        default: break
        }
        switch name {
        case "Bash": return .command
        case "Edit", "Write", "MultiEdit", "NotebookEdit": return .edit
        case "Read", "Grep", "Glob": return .read
        case let n where n.contains("send_user_file"): return .send
        default: return .other
        }
    }
}

/// One labelled piece of a tool call's input on the detail screen
struct ToolInputField: Equatable {
    let label: String
    let text: String
}

extension JSONValue {
    /// Readable JSON for the detail screen: sorted keys, two-space indent, strings unescaped where they stand alone
    var prettyText: String { pretty(indent: 0) }

    private func pretty(indent: Int) -> String {
        let pad = String(repeating: "  ", count: indent)
        let inner = String(repeating: "  ", count: indent + 1)
        switch self {
        case .string(let s):
            let escaped = s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
            return "\"\(escaped)\""
        case .number(let n): return n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        case .array(let items):
            if items.isEmpty { return "[]" }
            return "[\n" + items.map { inner + $0.pretty(indent: indent + 1) }.joined(separator: ",\n") + "\n" + pad + "]"
        case .object(let obj):
            if obj.isEmpty { return "{}" }
            return "{\n" + obj.keys.sorted().map { inner + "\"\($0)\": " + obj[$0]!.pretty(indent: indent + 1) }.joined(separator: ",\n") + "\n" + pad + "}"
        }
    }
}

/// Shown in place of an answer when the person dismissed the question in the CLI
let dismissedInCLIAnswer = "Dismissed in the CLI"

/// An AskUserQuestion question-answer pair (contents of the card kept in history after answering)
struct QAPair: Equatable {
    let question: String
    let answer: String
}

/// Unit laid out in chat. Consecutive tool calls collapse into a single .tools
enum ChatItem: Identifiable {
    case event(EventRecord)
    case tools(groupId: Int, calls: [ToolCall])
    /// An answered AskUserQuestion (kept in history as a question+answer card, official-app style)
    case qa(id: Int, pairs: [QAPair])
    /// A question the CLI is asking its person right now. Read-only: only the CLI can answer it
    case cliQuestion(id: Int, toolUseId: String, questions: [AskQuestion])

    var id: Int {
        switch self {
        case .event(let ev): ev.id
        case .tools(let groupId, _): groupId
        case .qa(let id, _): id
        case .cliQuestion(let id, _, _): id
        }
    }
}

/// Event sequence → display-unit sequence. Groups runs of tool_started/tool_finished.
/// Non-displayed events (turn_started, permissions, unknown) do not split a group
/// `answeringNow` is the question the answer card at the bottom of the chat is showing: it owns
/// that question until it is answered, so history leaves it out rather than printing it twice
func buildChatItems(_ events: [EventRecord], answeringNow: String? = nil) -> [ChatItem] {
    var out: [ChatItem] = []
    var current: [ToolCall] = []
    var groupId = 0
    // Fold consecutive detach/resume into one. A round trip ending in resume (idle)
    // is not displayed (the current state is the "In use by CLI" banner's job;
    // prevents a volley of toggles from becoming a wall)
    var stateRun: EventRecord?
    // AskUserQuestion question order (reqId / toolUseId → questions). Used to order the answer card
    var askedQuestions: [String: [AskQuestion]] = [:]
    // Where a CLI question's read-only card sits in `out`, so the answer replaces it in place
    // instead of leaving the question hanging above its own answer
    var cliQuestionAt: [String: Int] = [:]
    // Where each question's answer card sits in `out`, so a second answer for the same question
    // updates that card instead of adding another one
    var answeredQuestionAt: [String: Int] = [:]

    func flushTools() {
        if !current.isEmpty {
            out.append(.tools(groupId: groupId, calls: current))
            current = []
        }
    }

    func flushStateRun() {
        if let run = stateRun, case .sessionStateChanged(let status) = run.event, status == "detached" {
            out.append(.event(run))
        }
        stateRun = nil
    }

    for ev in events {
        switch ev.event {
        case .toolStarted(let name, let useId, let input, let kind, let summary):
            // AskUserQuestion does not appear as "Ran 1 tool" (the answer card owns the history; same as the official app)
            if name == "AskUserQuestion" || kind == "question" { continue }
            flushStateRun()
            if current.isEmpty { groupId = ev.id }
            current.append(ToolCall(id: useId.isEmpty ? "ev-\(ev.id)" : useId,
                                    name: name, input: input, isError: false,
                                    kindHint: kind, summary: summary))
        case .toolFinished(let useId, let isError, let output, let truncated):
            if let idx = current.lastIndex(where: { $0.id == useId }) {
                if isError { current[idx].isError = true }
                current[idx].output = output
                current[idx].outputTruncated = truncated
            }
        case .sessionStateChanged:
            flushTools()
            stateRun = ev   // consecutive ones are overwritten by the last state
        case .permissionRequested(let reqId, let toolName, let input):
            // Record the question order (the answers dictionary alone loses ordering for the answer card)
            if toolName == "AskUserQuestion" {
                let qs = AskUserQuestion.parse(input)
                if !qs.isEmpty { askedQuestions[reqId] = qs }
            }
        case .permissionResolved(let reqId, _, let answers):
            // AskUserQuestion answers stay in a history card together with their questions
            // (the official app's design). Plain allow/deny without answers remains
            // non-displayed and does not split a group
            if let answers, !answers.isEmpty {
                flushTools()
                flushStateRun()
                let order = askedQuestions[reqId]?.map(\.question) ?? answers.keys.sorted()
                var pairs = order.compactMap { q in answers[q].map { QAPair(question: q, answer: $0) } }
                let known = Set(order)   // keys missing from the question list are kept too (safety net)
                pairs += answers.filter { !known.contains($0.key) }
                    .sorted { $0.key < $1.key }
                    .map { QAPair(question: $0.key, answer: $0.value) }
                out.append(.qa(id: ev.id, pairs: pairs))
            }
        case .cliQuestion(let toolUseId, let input):
            // A question asked in a session tiny does not drive. It arrives from the transcript,
            // never through the permission flow, so it can only be shown, not answered
            let qs = AskUserQuestion.parse(input)
            if qs.isEmpty { continue }
            flushTools()
            flushStateRun()
            askedQuestions[toolUseId] = qs
            if toolUseId == answeringNow { continue }
            cliQuestionAt[toolUseId] = out.count
            out.append(.cliQuestion(id: ev.id, toolUseId: toolUseId, questions: qs))
        case .cliQuestionAnswered(let toolUseId, let answers, let rejected):
            let asked = askedQuestions[toolUseId] ?? []
            let order = asked.isEmpty ? answers.keys.sorted() : asked.map(\.question)
            var pairs = order.compactMap { q in
                answers[q].map { QAPair(question: q, answer: $0) }
                    // Dismissed in the CLI: the question stays in history, with no answer under it
                    ?? (rejected ? QAPair(question: q, answer: dismissedInCLIAnswer) : nil)
            }
            let known = Set(order)
            pairs += answers.filter { !known.contains($0.key) }
                .sorted { $0.key < $1.key }
                .map { QAPair(question: $0.key, answer: $0.value) }
            if pairs.isEmpty { continue }
            // The CLI writes its own record of a question the phone already answered (its prompt
            // was cancelled to deliver the answer), and the two can arrive in either order. One
            // card per question, and chosen answers always win over that cancellation
            if let at = answeredQuestionAt[toolUseId] {
                if !answers.isEmpty, case .qa(let id, _) = out[at] { out[at] = .qa(id: id, pairs: pairs) }
                continue
            }
            // Replace the read-only card in place when it is still on screen; a card whose question
            // fell outside the imported window is simply appended here
            if let at = cliQuestionAt[toolUseId], case .cliQuestion(let id, _, _) = out[at] {
                out[at] = .qa(id: id, pairs: pairs)
                cliQuestionAt[toolUseId] = nil
                answeredQuestionAt[toolUseId] = at
            } else {
                flushTools()
                flushStateRun()
                answeredQuestionAt[toolUseId] = out.count
                out.append(.qa(id: ev.id, pairs: pairs))
            }
        case .turnStarted, .unknown:
            continue   // non-displayed events do not split a group
        default:
            flushTools()
            flushStateRun()
            out.append(.event(ev))
        }
    }
    flushTools()
    flushStateRun()
    return out
}

/// "Ran 3 commands, edited 1 file"
func toolGroupSummary(_ calls: [ToolCall]) -> String {
    let commands = calls.filter { $0.kind == .command }.count
    let edits = calls.filter { $0.kind == .edit }.count
    let others = calls.count - commands - edits
    func plural(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }
    var parts: [String] = []
    if commands > 0 { parts.append("Ran \(plural(commands, "command"))") }
    if edits > 0 { parts.append("edited \(plural(edits, "file"))") }
    if others > 0 {
        parts.append(parts.isEmpty ? "Ran \(plural(others, "tool"))" : "\(plural(others, "other tool"))")
    }
    return parts.joined(separator: ", ")
}

/// The collapsed summary row in chat
struct ToolSummaryRow: View {
    let calls: [ToolCall]
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 6) {
                Text(toolGroupSummary(calls))
                    .font(.subheadline)
                    .kerning(1.2)   // meta-info letter spacing (same engraved look as EventRow's Done line)
                    .foregroundStyle(Color.tInkSub)
                    .lineLimit(1)
                    // When more tools bump the text from "Ran 1 command" to "Ran 2 commands",
                    // blend the swap so it isn't jarring (driven by the parent's animation)
                    .contentTransition(.opacity)
                if calls.contains(where: \.isError) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2).foregroundStyle(Color.tDetached)
                }
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.tInkSub)
                Spacer()
            }
        }
        .buttonStyle(.plain)
    }
}

/// Which call a row in the tool sheet opens (navigation value; the call itself is looked up by id)
struct ToolCallRef: Hashable {
    let id: String
}

/// Detail sheet opened by tapping. Each row opens the call's own screen (input and output)
struct ToolGroupSheet: View {
    let calls: [ToolCall]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(calls.enumerated()), id: \.element.id) { index, call in
                        NavigationLink(value: ToolCallRef(id: call.id)) {
                            HStack(alignment: .center, spacing: 12) {
                                Image(systemName: call.iconName)
                                    .font(.system(size: 15))
                                    .frame(width: 24)
                                    .foregroundStyle(.primary)
                                Text(call.verb)
                                    .font(.callout)
                                Text(call.label)
                                    .font(.callout)
                                    .fontDesign(.monospaced)
                                    .foregroundStyle(Color.tInkSub)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                if call.isError {
                                    Image(systemName: "exclamationmark.triangle.fill")
                                        .font(.caption).foregroundStyle(Color.tDetached)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Color.tInkSub)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("toolRow_\(call.id)")
                        .padding(.vertical, 10)
                        // Connector line (all but the last row)
                        if index < calls.count - 1 {
                            Rectangle()
                                .fill(.quaternary)
                                .frame(width: 1, height: 10)
                                .padding(.leading, 12)
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
            }
            .navigationTitle(toolGroupSummary(calls))
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: ToolCallRef.self) { ref in
                if let call = calls.first(where: { $0.id == ref.id }) {
                    ToolCallDetailView(call: call)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
