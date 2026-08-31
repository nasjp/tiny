import Foundation
import Security

/// App Group Keychain, used to share the e2eKey with the NSE.
/// Using the App Group ID directly as the access group is standard iOS behavior
/// (no keychain-access-groups entitlement needed).
enum SharedKeychain {
    static let accessGroup = "group.com.tanirell.tiny"
    private static let service = "com.tanirell.tiny"

    enum Key: String, CaseIterable {
        case serverURL, bearerToken, e2eKey, deviceId
    }

    private static func baseQuery(_ key: Key) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue,
        ]
        // On the simulator the access group works even without signing,
        // but it is required to share with the NSE on device.
        #if !targetEnvironment(simulator)
        q[kSecAttrAccessGroup as String] = accessGroup
        #endif
        return q
    }

    static func set(_ value: String, for key: Key) {
        let q = baseQuery(key)
        let attrs: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            // AfterFirstUnlock so the NSE can read the e2eKey while the device is locked
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]

        var status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)

        if status == errSecItemNotFound {
            var addQuery = q
            addQuery[kSecValueData as String] = Data(value.utf8)
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            status = SecItemAdd(addQuery as CFDictionary, nil)
        }

        if status != errSecSuccess {
            assertionFailure("SharedKeychain.set failed: \(status)")
        }
    }

    static func get(_ key: Key) -> String? {
        var q = baseQuery(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(_ key: Key) {
        SecItemDelete(baseQuery(key) as CFDictionary)
    }

    static func wipe() {
        Key.allCases.forEach(delete)
    }
}
