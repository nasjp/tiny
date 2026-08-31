import XCTest
@testable import Tiny

/// Mock that captures and inspects requests via URLProtocol
final class MockURLProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (Int, Data, [String: String]))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = Self.handler else { fatalError("handler not set") }
        let (status, data, headers) = handler(request)
        let resp = HTTPURLResponse(url: request.url!, statusCode: status,
                                   httpVersion: nil, headerFields: headers)!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class APIClientTests: XCTestCase {
    private var session: URLSession!
    private var client: APIClient!
    private let base = URL(string: "http://mac:7777")!

    override func setUp() {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        session = URLSession(configuration: config)
        client = APIClient(baseURL: base, token: "tok123", session: session)
    }

    /// A URLRequest's body can end up in httpBodyStream, so read both ways
    private func body(of request: URLRequest) -> Data {
        if let b = request.httpBody { return b }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data(); var buf = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buf, maxLength: buf.count)
            if n <= 0 { break }
            data.append(buf, count: n)
        }
        return data
    }

    func testRecentCwdsHitsCwdsEndpointAndDecodes() async throws {
        MockURLProtocol.handler = { req in
            XCTAssertEqual(req.url?.path, "/v1/cwds")
            XCTAssertEqual(req.httpMethod, "GET")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok123")
            let json = """
            {"cwds":["/Users/you/src/a","/Users/you/src/b"]}
            """
            return (200, Data(json.utf8), ["Content-Type": "application/json"])
        }
        let cwds = try await client.recentCwds()
        XCTAssertEqual(cwds, ["/Users/you/src/a", "/Users/you/src/b"])
    }

    func testSessionsSendsBearerAndDecodes() async throws {
        MockURLProtocol.handler = { req in
            XCTAssertEqual(req.url?.path, "/v1/sessions")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok123")
            let json = """
            {"sessions":[{"id":"u1","agentSessionId":null,"agent":"claude","profile":"work",
             "cwd":"/r","permissionMode":"default","title":"t","status":"running",
             "createdAt":"c","updatedAt":"u"}]}
            """
            return (200, Data(json.utf8), ["Content-Type": "application/json"])
        }
        let sessions = try await client.sessions()
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions[0].status, .running)
    }

    func testCreateSessionPostsBody() async throws {
        MockURLProtocol.handler = { req in
            XCTAssertEqual(req.httpMethod, "POST")
            let sent = try! JSONSerialization.jsonObject(with: self.body(of: req)) as! [String: Any]
            XCTAssertEqual(sent["profile"] as? String, "work")
            XCTAssertEqual(sent["cwd"] as? String, "/r")
            XCTAssertEqual(sent["permissionMode"] as? String, "acceptEdits")
            XCTAssertEqual(sent["model"] as? String, "opus")
            let json = """
            {"id":"u2","agentSessionId":null,"agent":"claude","profile":"work","cwd":"/r",
             "permissionMode":"acceptEdits","title":null,"status":"idle","createdAt":"c","updatedAt":"u"}
            """
            return (201, Data(json.utf8), [:])
        }
        let s = try await client.createSession(profile: "work", cwd: "/r",
                                               permissionMode: .acceptEdits, model: "opus")
        XCTAssertEqual(s.id, "u2")
    }

    func testErrorBodyBecomesAPIError() async {
        MockURLProtocol.handler = { _ in
            (409, Data(#"{"error":"turn already running"}"#.utf8), [:])
        }
        do {
            try await client.sendTurn(sessionId: "s", prompt: "hi", images: [])
            XCTFail("should have thrown")
        } catch let e as APIError {
            XCTAssertEqual(e.status, 409)
            XCTAssertEqual(e.message, "turn already running")
        } catch { XCTFail("\(error)") }
    }

    func testPairIsUnauthenticated() async throws {
        MockURLProtocol.handler = { req in
            XCTAssertEqual(req.url?.path, "/v1/devices")
            XCTAssertNil(req.value(forHTTPHeaderField: "Authorization"))
            let json = #"{"deviceId":"d1","bearerToken":"bt","e2eKey":"ek"}"#
            return (201, Data(json.utf8), [:])
        }
        let r = try await APIClient.pair(baseURL: base, code: "K7MPQ2XA", name: "iPhone", session: session)
        XCTAssertEqual(r.bearerToken, "bt")
    }

    func testRespondPermissionDenySendsMessage() async throws {
        MockURLProtocol.handler = { req in
            XCTAssertEqual(req.url?.path, "/v1/permissions/r1")
            let sent = try! JSONSerialization.jsonObject(with: self.body(of: req)) as! [String: Any]
            XCTAssertEqual(sent["behavior"] as? String, "deny")
            XCTAssertEqual(sent["message"] as? String, "stop")
            return (200, Data(#"{"ok":true}"#.utf8), [:])
        }
        try await client.respondPermission(reqId: "r1", allow: false, message: "stop")
    }

    func testRespondPermissionAllowSendsUpdatedInput() async throws {
        MockURLProtocol.handler = { req in
            XCTAssertEqual(req.url?.path, "/v1/permissions/r2")
            let sent = try! JSONSerialization.jsonObject(with: self.body(of: req)) as! [String: Any]
            XCTAssertEqual(sent["behavior"] as? String, "allow")
            let updated = sent["updatedInput"] as? [String: Any]
            let answers = updated?["answers"] as? [String: Any]
            XCTAssertEqual(answers?["Which one?"] as? String, "Option A")
            return (200, Data(#"{"ok":true}"#.utf8), [:])
        }
        let updatedInput: JSONValue = .object(["answers": .object(["Which one?": .string("Option A")])])
        try await client.respondPermission(reqId: "r2", allow: true, message: nil,
                                           updatedInput: updatedInput)
    }

    func testRespondPermissionAllowOmitsNilUpdatedInput() async throws {
        MockURLProtocol.handler = { req in
            let sent = try! JSONSerialization.jsonObject(with: self.body(of: req)) as! [String: Any]
            XCTAssertEqual(sent["behavior"] as? String, "allow")
            XCTAssertNil(sent["updatedInput"])   // nil omits the key entirely (encodeIfPresent)
            return (200, Data(#"{"ok":true}"#.utf8), [:])
        }
        try await client.respondPermission(reqId: "r3", allow: true, message: nil)
    }

    func testFileDataReturnsMime() async throws {
        MockURLProtocol.handler = { _ in
            (200, Data("<html></html>".utf8), ["Content-Type": "text/html"])
        }
        let (data, mime) = try await client.fileData(fileId: "f1")
        XCTAssertEqual(mime, "text/html")
        XCTAssertFalse(data.isEmpty)
    }

    func testEventsSendsSinceAsQueryItemAndDecodes() async throws {
        MockURLProtocol.handler = { req in
            XCTAssertEqual(req.url?.path, "/v1/sessions/s1/events")
            let items = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(items?.first(where: { $0.name == "since" })?.value, "42")
            let json = """
            {"events":[{"id":43,"sessionId":"s1","type":"assistant_text",
             "payload":{"text":"hi"},"createdAt":"c"}]}
            """
            return (200, Data(json.utf8), ["Content-Type": "application/json"])
        }
        let events = try await client.events(sessionId: "s1", since: 42)
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].id, 43)
        XCTAssertEqual(events[0].sessionId, "s1")
    }

    func testRegisterApnsToken() async throws {
        MockURLProtocol.handler = { req in
            XCTAssertEqual(req.httpMethod, "PATCH")
            XCTAssertEqual(req.url?.path, "/v1/devices/me")
            let sent = try! JSONSerialization.jsonObject(with: self.body(of: req)) as! [String: Any]
            XCTAssertEqual(sent["apnsToken"] as? String, "abcd")
            XCTAssertEqual(sent["apnsEnv"] as? String, "sandbox")
            return (200, Data(#"{"ok":true}"#.utf8), [:])
        }
        try await client.registerApnsToken("abcd", env: "sandbox")
    }
}
