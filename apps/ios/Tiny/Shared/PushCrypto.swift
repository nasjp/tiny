import Foundation
import CryptoKit
import UserNotifications

enum PushCryptoError: Error {
    case badInput
    case unsupportedVersion(Int)
}

/// Opens push payloads. Source of truth: docs/PUSH-PAYLOAD.md.
/// The Node side's nonce(12)‖ciphertext‖tag(16) (packages/server/src/crypto.ts) is directly
/// readable by CryptoKit's SealedBox(combined:) (verified by crypto-interop.sh).
///
/// **Do NOT add sealing (encryption) here.** The shipping binary's crypto must stay
/// decrypt-only (export-compliance basis = Apple's exemption (c) "limited to decryption";
/// see "Decisions" in HANDOFF). Production sealing is done by tinyd on the Mac;
/// test-only sealing lives in a TinyTests helper.
enum PushCrypto {
    static func decryptIntent(payloadBase64: String, e2eKeyBase64: String) throws -> PushIntent {
        guard let key = Data(base64Encoded: e2eKeyBase64), key.count == 32,
              let combined = Data(base64Encoded: payloadBase64) else {
            throw PushCryptoError.badInput
        }
        let box = try ChaChaPoly.SealedBox(combined: combined)
        let plain = try ChaChaPoly.open(box, using: SymmetricKey(data: key))
        let intent = try JSONDecoder().decode(PushIntent.self, from: plain)
        // Unknown v is treated like a decryption failure (safely ignore future payloads)
        guard intent.v == 1 else { throw PushCryptoError.unsupportedVersion(intent.v) }
        return intent
    }

    static func notificationContent(for intent: PushIntent) -> UNMutableNotificationContent {
        let c = UNMutableNotificationContent()
        c.title = intent.title
        c.body = intent.body
        c.sound = .default
        c.categoryIdentifier = intent.category
        c.interruptionLevel = intent.level == "time-sensitive" ? .timeSensitive : .active
        var tiny: [String: Any] = [
            "sessionId": intent.sessionId,
            "type": intent.type,
            "eventId": intent.eventId,
        ]
        if let reqId = intent.reqId { tiny["reqId"] = reqId }
        c.userInfo = ["tiny": tiny]
        return c
    }
}
