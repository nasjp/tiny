import Foundation

enum EventStreamPolicy {
    static func wsURL(baseURL: URL, sessionId: String, token: String, since: Int) -> URL {
        var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        c.scheme = c.scheme == "https" ? "wss" : "ws"
        c.path = "/v1/sessions/\(sessionId)/stream"
        c.queryItems = [
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "since", value: String(since)),
        ]
        return c.url!
    }

    /// 4401 = auth failure (the server is designed to close with this code after the 101
    /// completes; see ws.ts). Must not reconnect = re-pairing is required.
    static func shouldReconnect(closeCode: Int?) -> Bool {
        guard let code = closeCode else { return true }
        return code != 4401 && code != 1000
    }

    static func backoffSeconds(attempt: Int) -> Int {
        min(30, 1 << min(attempt, 5))
    }
}

/// Subscription to WS /v1/sessions/:id/stream. Frames are raw EventRecord JSON (no envelope).
/// Because there is a gap window between backlog and live, the initial history is handled by
/// REST (ChatModel); this layer is responsible only for reconnecting with the last received
/// id as `since`.
final class EventStream {
    private let baseURL: URL
    private let sessionId: String
    private let token: String
    private var task: URLSessionWebSocketTask?
    private var loopTask: Task<Void, Never>?
    private var cancelled = false
    var onAuthFailure: (() -> Void)?

    init(baseURL: URL, sessionId: String, token: String) {
        self.baseURL = baseURL
        self.sessionId = sessionId
        self.token = token
    }

    func connect(since: Int) -> AsyncStream<EventRecord> {
        loopTask?.cancel()
        return AsyncStream { continuation in
            let loop = Task { [weak self] in
                guard let self else { return }
                var cursor = since
                var attempt = 0
                while !self.cancelled {
                    let url = EventStreamPolicy.wsURL(
                        baseURL: self.baseURL, sessionId: self.sessionId,
                        token: self.token, since: cursor)
                    let ws = URLSession.shared.webSocketTask(with: url)
                    self.task = ws
                    ws.resume()
                    do {
                        while !self.cancelled {
                            let msg = try await ws.receive()
                            attempt = 0
                            guard case .string(let text) = msg,
                                  let ev = try? JSONDecoder().decode(EventRecord.self,
                                                                     from: Data(text.utf8)) else { continue }
                            cursor = max(cursor, ev.id)
                            continuation.yield(ev)
                        }
                    } catch {
                        // A throw from receive() = disconnected. closeCode decides whether to reconnect.
                        // 4401 can be applied asynchronously on the server side, so while it's .invalid
                        // re-read up to 3 times with 100ms waits (to avoid treating it as nil right away
                        // and reconnecting by mistake).
                        var closeCode = ws.closeCode
                        if closeCode == .invalid {
                            for _ in 0..<3 {
                                if closeCode != .invalid { break }
                                try? await Task.sleep(nanoseconds: 100_000_000)
                                closeCode = ws.closeCode
                            }
                        }
                        let code = closeCode == .invalid ? nil : closeCode.rawValue
                        if code == 4401 { self.onAuthFailure?() }
                        if self.cancelled || !EventStreamPolicy.shouldReconnect(closeCode: code) { break }
                        do {
                            try await Task.sleep(
                                nanoseconds: UInt64(EventStreamPolicy.backoffSeconds(attempt: attempt)) * 1_000_000_000)
                        } catch {
                            break
                        }
                        attempt += 1
                    }
                }
                continuation.finish()
            }
            self.loopTask = loop
            continuation.onTermination = { [weak self] _ in self?.cancel() }
        }
    }

    func cancel() {
        cancelled = true
        loopTask?.cancel()
        task?.cancel(with: .normalClosure, reason: nil)
    }
}
