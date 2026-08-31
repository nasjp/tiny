import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        // The relay is unauthenticated, so third parties can inject arbitrary ciphertext.
        // AEAD makes forgery impossible, but showing a placeholder for notifications that
        // fail to decrypt would create a spam channel. On failure, deliver empty content
        // to effectively suppress display (docs/PUSH-PAYLOAD.md).
        guard let p = request.content.userInfo["p"] as? String else {
            suppress(contentHandler, debugReason: "missing p")
            return
        }
        guard let e2eKey = SharedKeychain.get(.e2eKey) else {
            suppress(contentHandler, debugReason: "can't read e2eKey from Keychain")
            return
        }
        do {
            let intent = try PushCrypto.decryptIntent(payloadBase64: p, e2eKeyBase64: e2eKey)
            contentHandler(PushCrypto.notificationContent(for: intent))
        } catch {
            suppress(contentHandler, debugReason: "decryption failed: \(error)")
        }
    }

    /// In production, suppress display with empty content (docs/PUSH-PAYLOAD.md).
    /// DEBUG builds only show the failure reason for troubleshooting.
    private func suppress(_ handler: (UNNotificationContent) -> Void, debugReason: String) {
        #if DEBUG
        let c = UNMutableNotificationContent()
        c.title = "tiny NSE debug"
        c.body = debugReason
        handler(c)
        #else
        handler(UNNotificationContent())
        #endif
    }

    override func serviceExtensionTimeWillExpire() {
        // Never show a placeholder even on timeout (never display content that wasn't decrypted)
        contentHandler?(UNNotificationContent())
    }
}
