import Foundation

protocol TinyBackend: AnyObject {
    var isDemo: Bool { get }
    func profiles() async throws -> [ProfileInfo]
    /// Equivalent of Claude Code's /usage (session/weekly usage rates and reset times). Per profile
    func profileUsage(name: String) async throws -> ProfileUsage
    func sessions() async throws -> [SessionRecord]
    /// List of archived sessions (for the Archived screen)
    func archivedSessions() async throws -> [SessionRecord]
    /// Archive/restore. The server returns 409 when archiving a running or detached session
    func setArchived(sessionId: String, archived: Bool) async throws -> SessionRecord
    /// cwd candidates for New Session. Includes archived cwds (deriving from the list would lose them all once everything is archived)
    func recentCwds() async throws -> [String]
    func createSession(profile: String, cwd: String, permissionMode: PermissionMode, model: String?, effort: String?) async throws -> SessionRecord
    func events(sessionId: String, since: Int) async throws -> [EventRecord]
    func sendTurn(sessionId: String, prompt: String, images: [TurnImageAttachment]) async throws
    func interrupt(sessionId: String) async throws
    /// tiny attach leaves the session at detached:true and never restores it (because it execs).
    /// This is the only way to take it back from the app.
    func setDetached(sessionId: String, detached: Bool) async throws
    /// Mid-session change of model / effort ("" = reset to default, nil = leave unchanged) / permission mode / title. Takes effect from the next turn
    func updateSession(sessionId: String, model: String?, permissionMode: PermissionMode?, effort: String?, title: String?) async throws -> SessionRecord
    func pendingPermissions(sessionId: String) async throws -> [PendingPermission]
    /// Pass updatedInput only when returning AskUserQuestion answers written into input.answers
    func respondPermission(reqId: String, allow: Bool, message: String?, updatedInput: JSONValue?) async throws
    /// Answer a question the CLI asked on its own (arrives as cli_question, not through the permission flow)
    func answerCliQuestion(sessionId: String, toolUseId: String, answers: [String: String]) async throws
    func fileData(fileId: String) async throws -> (data: Data, mime: String)
    func eventStream(sessionId: String, since: Int) -> AsyncStream<EventRecord>
}

/// Real-server implementation. Just bundles APIClient (REST) and EventStream (WS).
final class LiveBackend: TinyBackend {
    let isDemo = false
    private let api: APIClient
    private let baseURL: URL
    private let token: String
    var onAuthFailure: (() -> Void)?
    /// Holds a strong reference to each session's EventStream.
    /// Without this, ARC frees it as soon as eventStream() returns and the WS connection silently never establishes.
    private var streams: [String: EventStream] = [:]

    init(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token
        self.api = APIClient(baseURL: baseURL, token: token)
    }

    func profiles() async throws -> [ProfileInfo] { try await api.profiles() }
    func profileUsage(name: String) async throws -> ProfileUsage { try await api.profileUsage(name: name) }
    func sessions() async throws -> [SessionRecord] { try await api.sessions() }
    func archivedSessions() async throws -> [SessionRecord] { try await api.sessions(archived: true) }
    func recentCwds() async throws -> [String] { try await api.recentCwds() }
    func setArchived(sessionId: String, archived: Bool) async throws -> SessionRecord {
        try await api.setArchived(sessionId: sessionId, archived: archived)
    }
    func createSession(profile: String, cwd: String, permissionMode: PermissionMode, model: String?, effort: String?) async throws -> SessionRecord {
        try await api.createSession(profile: profile, cwd: cwd, permissionMode: permissionMode, model: model, effort: effort)
    }
    func events(sessionId: String, since: Int) async throws -> [EventRecord] {
        try await api.events(sessionId: sessionId, since: since)
    }
    func sendTurn(sessionId: String, prompt: String, images: [TurnImageAttachment]) async throws {
        try await api.sendTurn(sessionId: sessionId, prompt: prompt, images: images)
    }
    func interrupt(sessionId: String) async throws { try await api.interrupt(sessionId: sessionId) }
    func setDetached(sessionId: String, detached: Bool) async throws {
        try await api.setDetached(sessionId: sessionId, detached: detached)
    }
    func updateSession(sessionId: String, model: String?, permissionMode: PermissionMode?, effort: String?, title: String?) async throws -> SessionRecord {
        try await api.updateSession(sessionId: sessionId, model: model, permissionMode: permissionMode, effort: effort, title: title)
    }
    func pendingPermissions(sessionId: String) async throws -> [PendingPermission] {
        try await api.pendingPermissions(sessionId: sessionId)
    }
    func respondPermission(reqId: String, allow: Bool, message: String?, updatedInput: JSONValue?) async throws {
        try await api.respondPermission(reqId: reqId, allow: allow, message: message, updatedInput: updatedInput)
    }
    func answerCliQuestion(sessionId: String, toolUseId: String, answers: [String: String]) async throws {
        try await api.answerCliQuestion(sessionId: sessionId, toolUseId: toolUseId, answers: answers)
    }
    func fileData(fileId: String) async throws -> (data: Data, mime: String) {
        try await api.fileData(fileId: fileId)
    }
    func eventStream(sessionId: String, since: Int) -> AsyncStream<EventRecord> {
        streams[sessionId]?.cancel()
        let stream = EventStream(baseURL: baseURL, sessionId: sessionId, token: token)
        stream.onAuthFailure = { [weak self] in self?.onAuthFailure?() }
        streams[sessionId] = stream
        return stream.connect(since: since)
    }
    func registerApnsToken(_ hexToken: String, env: String) async throws {
        try await api.registerApnsToken(hexToken, env: env)
    }
}
