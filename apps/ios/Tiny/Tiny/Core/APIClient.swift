import Foundation

struct APIError: Error, LocalizedError {
    let status: Int
    let message: String
    /// Why a usage lookup produced nothing: signed_out / unavailable / unsupported / failed
    /// (usage.ts). nil for every other endpoint, and for a tinyd older than this field
    var problem: String? = nil
    /// The command that fixes it, ready to be typed on the Mac
    var hint: String? = nil
    /// Raw upstream text (a 401 body, a spawn error). Shown only when the reader asks for it
    var detail: String? = nil
    var errorDescription: String? { message }
}

/// tinyd REST client. Errors are always {"error": "..."} JSON (api.ts:47-52).
final class APIClient {
    let baseURL: URL
    let token: String?
    private let session: URLSession

    init(baseURL: URL, token: String?, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    // MARK: - Low level

    private struct ErrorBody: Codable {
        let error: String
        var problem: String? = nil
        var hint: String? = nil
        var detail: String? = nil
    }

    private static func check(_ data: Data, _ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError(status: 0, message: "no response") }
        guard (200..<300).contains(http.statusCode) else {
            guard let body = try? JSONDecoder().decode(ErrorBody.self, from: data) else {
                throw APIError(status: http.statusCode, message: "HTTP \(http.statusCode)")
            }
            throw APIError(status: http.statusCode, message: body.error,
                           problem: body.problem, hint: body.hint, detail: body.detail)
        }
    }

    /// A `body: Encodable?` can't be passed directly to `JSONEncoder().encode` because of
    /// Swift's existential constraints (compile error), so callers pass pre-encoded `Data`.
    private func request(_ method: String, _ path: String, queryItems: [URLQueryItem]? = nil,
                         body: Data? = nil) async throws -> Data {
        var req = URLRequest(url: Self.url(baseURL: baseURL, path: path, queryItems: queryItems))
        req.httpMethod = method
        req.timeoutInterval = 15
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        let (data, resp) = try await session.data(for: req)
        try Self.check(data, resp)
        return data
    }

    /// Appending the query with `appendingPathComponent` percent-encodes `?` and `=`,
    /// which 404s on the real server, so build with URLComponents + queryItems.
    private static func url(baseURL: URL, path: String, queryItems: [URLQueryItem]?) -> URL {
        guard let queryItems, !queryItems.isEmpty else {
            return baseURL.appendingPathComponent(path)
        }
        var c = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        c.queryItems = queryItems
        return c.url!
    }

    private func get<T: Decodable>(_ path: String, queryItems: [URLQueryItem]? = nil,
                                   as type: T.Type) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await request("GET", path, queryItems: queryItems))
    }

    // MARK: - Pairing (unauthenticated)

    static func pair(baseURL: URL, code: String, name: String,
                     session: URLSession = .shared) async throws -> PairResponse {
        struct Body: Codable { let code: String; let name: String }
        var req = URLRequest(url: baseURL.appendingPathComponent("/v1/devices"))
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(Body(code: code, name: name))
        let (data, resp) = try await session.data(for: req)
        try check(data, resp)
        return try JSONDecoder().decode(PairResponse.self, from: data)
    }

    // MARK: - API

    func health() async throws { _ = try await request("GET", "/v1/health") }

    func profiles() async throws -> [ProfileInfo] {
        struct R: Codable { let profiles: [ProfileInfo] }
        return try await get("/v1/profiles", as: R.self).profiles
    }

    func profileUsage(name: String) async throws -> ProfileUsage {
        try JSONDecoder().decode(ProfileUsage.self,
                                 from: try await request("GET", "/v1/profiles/\(name)/usage"))
    }

    func sessions(archived: Bool = false) async throws -> [SessionRecord] {
        struct R: Codable { let sessions: [SessionRecord] }
        let query = archived ? [URLQueryItem(name: "archived", value: "true")] : nil
        return try await get("/v1/sessions", queryItems: query, as: R.self).sessions
    }

    /// Working-directory history (includes cwds of archived sessions, only those that exist on the Mac, newest first)
    func recentCwds() async throws -> [String] {
        struct R: Codable { let cwds: [String] }
        return try await get("/v1/cwds", as: R.self).cwds
    }

    /// Archive/restore. The server returns 409 when archiving a running or detached session
    func setArchived(sessionId: String, archived: Bool) async throws -> SessionRecord {
        struct Body: Codable { let archived: Bool }
        let bodyData = try JSONEncoder().encode(Body(archived: archived))
        let data = try await request("PATCH", "/v1/sessions/\(sessionId)", body: bodyData)
        return try JSONDecoder().decode(SessionRecord.self, from: data)
    }

    func createSession(profile: String, cwd: String,
                       permissionMode: PermissionMode, model: String? = nil,
                       effort: String? = nil) async throws -> SessionRecord {
        struct Body: Codable {
            let profile: String
            let cwd: String
            let permissionMode: String
            let model: String?    // nil omits the key entirely (encodeIfPresent)
            let effort: String?
        }
        let bodyData = try JSONEncoder().encode(
            Body(profile: profile, cwd: cwd, permissionMode: permissionMode.rawValue,
                 model: model, effort: effort))
        let data = try await request("POST", "/v1/sessions", body: bodyData)
        return try JSONDecoder().decode(SessionRecord.self, from: data)
    }

    func events(sessionId: String, since: Int) async throws -> [EventRecord] {
        struct R: Codable { let events: [EventRecord] }
        return try await get("/v1/sessions/\(sessionId)/events",
                             queryItems: [URLQueryItem(name: "since", value: String(since))],
                             as: R.self).events
    }

    func sendTurn(sessionId: String, prompt: String,
                  images: [TurnImageAttachment] = []) async throws {
        struct Img: Codable { let data: String; let mediaType: String }
        struct Body: Codable { let prompt: String; let images: [Img]? }
        let imgs = images.isEmpty ? nil
            : images.map { Img(data: $0.data.base64EncodedString(), mediaType: $0.mediaType) }
        let bodyData = try JSONEncoder().encode(Body(prompt: prompt, images: imgs))
        _ = try await request("POST", "/v1/sessions/\(sessionId)/turns", body: bodyData)
    }

    func interrupt(sessionId: String) async throws {
        _ = try await request("POST", "/v1/sessions/\(sessionId)/interrupt")
    }

    /// Mid-session change of model / permission mode. model "" means "reset to CLI default"
    /// (sent to the server as null). nil arguments are left unchanged
    func updateSession(sessionId: String, model: String?, permissionMode: PermissionMode?,
                       effort: String? = nil, title: String? = nil) async throws -> SessionRecord {
        var dict: [String: Any] = [:]
        if let model { dict["model"] = model.isEmpty ? NSNull() : model }
        if let effort { dict["effort"] = effort.isEmpty ? NSNull() : effort }
        if let title, !title.isEmpty { dict["title"] = title }
        if let permissionMode { dict["permissionMode"] = permissionMode.rawValue }
        let bodyData = try JSONSerialization.data(withJSONObject: dict)
        let data = try await request("PATCH", "/v1/sessions/\(sessionId)", body: bodyData)
        return try JSONDecoder().decode(SessionRecord.self, from: data)
    }

    func setDetached(sessionId: String, detached: Bool) async throws {
        struct Body: Codable { let detached: Bool }
        let bodyData = try JSONEncoder().encode(Body(detached: detached))
        _ = try await request("POST", "/v1/sessions/\(sessionId)/detach", body: bodyData)
    }

    func pendingPermissions(sessionId: String) async throws -> [PendingPermission] {
        struct R: Codable { let pending: [PendingPermission] }
        return try await get("/v1/sessions/\(sessionId)/permissions", as: R.self).pending
    }

    func respondPermission(reqId: String, allow: Bool, message: String?,
                           updatedInput: JSONValue? = nil) async throws {
        if allow {
            // updatedInput is the input with AskUserQuestion answers written in; nil omits the key entirely
            struct Body: Codable { let behavior: String; let updatedInput: JSONValue? }
            let bodyData = try JSONEncoder().encode(Body(behavior: "allow", updatedInput: updatedInput))
            _ = try await request("POST", "/v1/permissions/\(reqId)", body: bodyData)
        } else {
            struct Body: Codable { let behavior: String; let message: String }
            let bodyData = try JSONEncoder().encode(Body(behavior: "deny", message: message ?? "denied"))
            _ = try await request("POST", "/v1/permissions/\(reqId)", body: bodyData)
        }
    }

    /// Answer a question the CLI itself asked (AskUserQuestion in a session tiny does not drive).
    /// The server hands it to the CLI over its messaging socket; 409 = that CLI is gone
    func answerCliQuestion(sessionId: String, toolUseId: String, answers: [String: String]) async throws {
        struct Body: Codable { let toolUseId: String; let answers: [String: String] }
        let bodyData = try JSONEncoder().encode(Body(toolUseId: toolUseId, answers: answers))
        _ = try await request("POST", "/v1/sessions/\(sessionId)/questions", body: bodyData)
    }

    func registerApnsToken(_ hexToken: String, env: String) async throws {
        struct Body: Codable { let apnsToken: String; let apnsEnv: String }
        let bodyData = try JSONEncoder().encode(Body(apnsToken: hexToken, apnsEnv: env))
        _ = try await request("PATCH", "/v1/devices/me", body: bodyData)
    }

    func fileData(fileId: String) async throws -> (data: Data, mime: String) {
        var req = URLRequest(url: baseURL.appendingPathComponent("/v1/files/\(fileId)"))
        req.timeoutInterval = 15
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, resp) = try await session.data(for: req)
        try Self.check(data, resp)
        let mime = (resp as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
        return (data, mime)
    }
}
