import Foundation
import SwiftUI
import UIKit

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var backend: TinyBackend?
    @Published var pairingError: String?
    /// Session-list cache. Kept while away from the screen so the previous content shows the
    /// instant you return (the refetch runs in the background and replaces it). Discarded when the backend changes
    @Published var sessions: [SessionRecord] = []
    @Published var sessionsLoaded = false
    /// Per-session ChatModel cache. Prevents the flicker of refetching history on every
    /// visit (empty screen → redraw); events stay inside the model
    private var chatModels: [String: ChatModel] = [:]

    func chatModel(for session: SessionRecord) -> ChatModel? {
        guard let backend else { return nil }
        if let cached = chatModels[session.id] { return cached }
        let model = ChatModel(backend: backend, session: session)
        chatModels[session.id] = model
        return model
    }

    /// Invalidate caches on backend switches (pairing, demo, unpairing)
    private func resetCaches() {
        sessions = []
        sessionsLoaded = false
        chatModels = [:]
    }

    var serverURL: URL? {
        SharedKeychain.get(.serverURL).flatMap(URL.init(string:))
    }
    var bearerToken: String? { SharedKeychain.get(.bearerToken) }
    var isPaired: Bool { serverURL != nil && bearerToken != nil }

    func bootstrap() {
        if ProcessInfo.processInfo.arguments.contains("-DemoMode") {
            backend = DemoBackend()
            return
        }
        if let url = serverURL, let token = bearerToken {
            backend = makeLive(url: url, token: token)
        }
    }

    func pair(qr: PairQR, deviceName: String) async {
        pairingError = nil
        guard let url = URL(string: qr.url), AppModel.isAcceptablePairingURL(url) else {
            pairingError = "This QR points somewhere unexpected. tiny only pairs with your Mac on your local network or Tailscale."
            return
        }
        do {
            let r = try await APIClient.pair(baseURL: url, code: qr.code, name: deviceName)
            // The e2eKey appears only in this response. Share it with the NSE via the App Group Keychain
            SharedKeychain.set(qr.url, for: .serverURL)
            SharedKeychain.set(r.bearerToken, for: .bearerToken)
            SharedKeychain.set(r.e2eKey, for: .e2eKey)
            SharedKeychain.set(r.deviceId, for: .deviceId)
            resetCaches()
            backend = makeLive(url: url, token: r.bearerToken)
            // The didRegisterForRemoteNotificationsWithDeviceToken right after launch (unpaired)
            // is ignored because backend is nil. Re-register after successful pairing so the
            // token gets sent via PATCH /v1/devices/me.
            UIApplication.shared.registerForRemoteNotifications()
        } catch let e as APIError where e.status == 403 {
            // Pairing codes are strictly one-time (not reusable even after a failure)
            pairingError = "This code is invalid. Run `tiny pair` again on your Mac to get a new QR code."
        } catch {
            pairingError = "Can't connect: \(error.localizedDescription)\n\(Self.connectionErrorHint)"
        }
    }

    /// Guidance on connection failure. tinyd is reachable over both LAN and Tailscale, so the
    /// old wording (Tailscale only) would lose first-time users on a LAN
    static let connectionErrorHint =
        "Check that your Mac is on the same network (LAN or Tailscale) and that tinyd is running."

    /// Validates that the pairing-QR destination stays within "your own Mac" territory.
    /// tinyd is expected to be reachable over the same LAN (private IP) or Tailscale
    /// (100.64.0.0/10, *.ts.net), so never send the bearer to any other external host.
    /// Entry guard so scanning an attacker-supplied QR can't hijack the control path.
    nonisolated static func isAcceptablePairingURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        guard let host = url.host?.lowercased(), !host.isEmpty else { return false }

        // Tailscale MagicDNS names
        if host.hasSuffix(".ts.net") { return true }
        // .local (mDNS / same LAN)
        if host.hasSuffix(".local") { return true }

        // IPv4 literals are limited to private / CGNAT (Tailscale) / loopback
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        if octets.count == 4, octets.allSatisfy({ UInt8($0) != nil }) {
            let b = octets.map { UInt8($0)! }
            if b[0] == 10 { return true }                                   // 10.0.0.0/8
            if b[0] == 192 && b[1] == 168 { return true }                    // 192.168.0.0/16
            if b[0] == 172 && (16...31).contains(b[1]) { return true }       // 172.16.0.0/12
            if b[0] == 100 && (64...127).contains(b[1]) { return true }      // 100.64.0.0/10 (Tailscale CGNAT)
            if b[0] == 127 { return true }                                   // loopback (simulator / development)
            return false
        }
        // IPv6: only Tailscale's fd7a:115c:a1e0::/48 and loopback are allowed
        if host.hasPrefix("fd7a:115c:a1e0") { return true }
        if host == "::1" || host == "[::1]" { return true }
        return false
    }

    func enterDemo() {
        resetCaches()
        backend = DemoBackend()
    }

    #if DEBUG
    /// Test-only: inject an arbitrary backend (e.g. fixtures of real events)
    func useBackendForTesting(_ b: TinyBackend) {
        resetCaches()
        backend = b
    }
    #endif

    func unpair() {
        SharedKeychain.wipe()
        resetCaches()
        backend = nil
    }

    private func makeLive(url: URL, token: String) -> LiveBackend {
        let live = LiveBackend(baseURL: url, token: token)
        live.onAuthFailure = { [weak self] in
            Task { @MainActor in self?.unpair() }   // 4401 = device revoked; back to pairing
        }
        return live
    }
}
