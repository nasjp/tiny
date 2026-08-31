import SwiftUI
import UserNotifications

@main
struct TinyApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()
    @AppStorage("appearance") private var appearanceRaw = Appearance.system.rawValue

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .onAppear {
                    delegate.model = model
                    model.bootstrap()
                    delegate.setupNotifications()
                }
                .tint(.tTint)
                .font(.tinyBody)
                .preferredColorScheme(Appearance(rawValue: appearanceRaw)?.colorScheme)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    weak var model: AppModel?

    func setupNotifications() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        // Allow/deny from the lock screen (PushIntent.category = "tiny.permission")
        let allow = UNNotificationAction(identifier: "TINY_ALLOW", title: "Allow",
                                         options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: "TINY_DENY", title: "Deny",
                                        options: [.destructive, .authenticationRequired])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "tiny.permission", actions: [allow, deny],
                                   intentIdentifiers: []),
            // AskUserQuestion: can't be answered with Allow/Deny, so no actions (tap to open and answer)
            UNNotificationCategory(identifier: "tiny.question", actions: [], intentIdentifiers: []),
            UNNotificationCategory(identifier: "tiny.info", actions: [], intentIdentifiers: []),
        ])

        Task {
            let granted = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            if granted == true {
                await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
            }
        }
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        // tinyd deletes the token from its DB on BadDeviceToken; this PATCH is the only recovery
        // path, so send on every launch even when unchanged (required by docs/PUSH-PAYLOAD.md)
        #if DEBUG
        let env = "sandbox"      // tokens from direct Xcode runs are sandbox; production always yields BadDeviceToken
        #else
        let env = "production"   // TestFlight / App Store
        #endif
        Task { @MainActor in
            guard let live = self.model?.backend as? LiveBackend else { return }
            try? await live.registerApnsToken(hex, env: env)
        }
    }

    // Show notifications while in the foreground too
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification)
        async -> UNNotificationPresentationOptions {
        // Without .list, notifications received in the foreground never land in
        // Notification Center and it looks like nothing arrived (measured in on-device E2E)
        [.banner, .list, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        guard let tiny = userInfo["tiny"] as? [String: Any],
              let sessionId = tiny["sessionId"] as? String else { return }

        switch response.actionIdentifier {
        case "TINY_ALLOW", "TINY_DENY":
            guard let reqId = tiny["reqId"] as? String else { return }
            let allow = response.actionIdentifier == "TINY_ALLOW"
            // Right after a cold launch, delegate.model wiring (TinyApp.onAppear) hasn't run yet
            // and self.model can be nil. Reading the same data source as AppModel.serverURL/bearerToken
            // (SharedKeychain) directly lets us handle the action even before the model is wired.
            guard let urlString = SharedKeychain.get(.serverURL),
                  let url = URL(string: urlString),
                  let token = SharedKeychain.get(.bearerToken) else {
                await postFallbackNotification(center: center, sessionId: sessionId, tiny: tiny)
                return
            }
            do {
                let api = APIClient(baseURL: url, token: token)
                try await api.respondPermission(reqId: reqId, allow: allow, message: nil)
            } catch {
                // Can fail when Tailscale is disconnected or the request already timed out → route the user into the app to respond
                await postFallbackNotification(center: center, sessionId: sessionId, tiny: tiny)
            }
        default:
            // Tap → open that session (doesn't crash on unresolvable IDs like "push-test":
            // SessionListView does nothing if it still can't find it after a reload)
            await MainActor.run {
                NotificationCenter.default.post(name: .tinyOpenSession, object: nil,
                                                userInfo: ["sessionId": sessionId])
            }
        }
    }

    // When the allow/deny action couldn't be sent, post a local notification asking the user
    // to open the app and respond (same path for unpaired SharedKeychain, network loss, and API failure)
    private func postFallbackNotification(center: UNUserNotificationCenter, sessionId: String,
                                          tiny: [String: Any]) async {
        let c = UNMutableNotificationContent()
        c.title = "Couldn't respond"
        c.body = "Open the app to respond to the permission request."
        c.sound = .default
        c.userInfo = ["tiny": ["sessionId": sessionId, "type": "permission_requested",
                               "eventId": tiny["eventId"] ?? 0]]
        try? await center.add(UNNotificationRequest(
            identifier: UUID().uuidString, content: c, trigger: nil))
    }
}
