import XCTest
import CryptoKit
@testable import Tiny

final class PushCryptoTests: XCTestCase {
    /// Test-only sealing. **Never place this in production source (Shared/PushCrypto.swift)** —
    /// keeps the shipped binary's crypto decrypt-only (export-compliance basis = Apple's
    /// exemption (c) "limited to decryption"; see HANDOFF "decisions"). Production sealing
    /// is done by tinyd on the Mac
    private static func sealForTesting(_ intent: PushIntent, e2eKeyBase64: String) throws -> String {
        let key = try XCTUnwrap(Data(base64Encoded: e2eKeyBase64))
        let plain = try JSONEncoder().encode(intent)
        let box = try ChaChaPoly.seal(plain, using: SymmetricKey(data: key))
        return box.combined.base64EncodedString()
    }

    private let key = Data((0..<32).map { UInt8($0) }).base64EncodedString()
    private let intent = PushIntent(
        v: 1, type: "permission_requested", sessionId: "s1", eventId: 42,
        title: "my-repo", body: "Requesting permission to run Bash",
        category: "tiny.permission", level: "time-sensitive", reqId: "r1")

    func testRoundTrip() throws {
        let sealed = try Self.sealForTesting(intent, e2eKeyBase64: key)
        let opened = try PushCrypto.decryptIntent(payloadBase64: sealed, e2eKeyBase64: key)
        XCTAssertEqual(opened.reqId, "r1")
        XCTAssertEqual(opened.eventId, 42)
        XCTAssertEqual(opened.category, "tiny.permission")
    }

    func testWrongKeyThrows() throws {
        let sealed = try Self.sealForTesting(intent, e2eKeyBase64: key)
        let wrong = Data((1..<33).map { UInt8($0) }).base64EncodedString()
        XCTAssertThrowsError(try PushCrypto.decryptIntent(payloadBase64: sealed, e2eKeyBase64: wrong))
    }

    func testGarbageBase64Throws() {
        XCTAssertThrowsError(try PushCrypto.decryptIntent(payloadBase64: "!!!", e2eKeyBase64: key))
    }

    // An unknown v is treated the same as a decryption failure (the default per PUSH-PAYLOAD.md)
    func testUnknownVersionThrows() throws {
        let future = """
        {"v":2,"type":"turn_completed","sessionId":"s","eventId":1,"title":"t","body":"b",
         "category":"tiny.info","level":"active"}
        """
        let keyData = Data(base64Encoded: key)!
        let box = try ChaChaPoly.seal(Data(future.utf8), using: SymmetricKey(data: keyData))
        XCTAssertThrowsError(try PushCrypto.decryptIntent(
            payloadBase64: box.combined.base64EncodedString(), e2eKeyBase64: key))
    }

    // Shape check that it matches the Node crypto.ts combined format (nonce12‖ct‖tag16)
    func testSealedFormatIsCombined() throws {
        let sealed = try Self.sealForTesting(intent, e2eKeyBase64: key)
        let data = Data(base64Encoded: sealed)!
        let plainLen = try JSONEncoder().encode(intent).count
        XCTAssertEqual(data.count, plainLen + 28)   // 12 (nonce) + 16 (tag)
    }
}
