import Foundation
import UIKit

/// The user's own message shown locally right after send (optimistic UI).
/// Replaced when the real user_message arrives over WS.
/// spec: docs/superpowers/specs/2026-08-28-optimistic-send-design.md
struct OptimisticSend: Identifiable, Equatable {
    let id = UUID()
    let text: String
    /// Local thumbnails of the attachments (the real event re-fetches via fileId,
    /// but right after send the on-hand images are shown as-is)
    let thumbnails: [UIImage]
    let createdAt = Date()
}

@MainActor
final class ChatModel: ObservableObject {
    @Published private(set) var events: [EventRecord] = []
    @Published private(set) var pending: [PendingPermission] = []
    @Published private(set) var isRunning = false
    /// Messages already sent but whose WS user_message has not arrived yet
    @Published private(set) var pendingSends: [OptimisticSend] = []
    @Published private(set) var isDetached = false
    /// Whether the agent's own CLI still has this session open (mirrors SessionRecord.isHeldByCLI).
    /// Sourced fresh here instead of read from the SessionRecord ChatView was pushed with, because that
    /// snapshot never changes while the chat stays open — see cliLiveTask below.
    @Published private(set) var isHeldByCLI: Bool
    /// Context consumption of the latest turn (input+cache+output tokens). nil = unknown so far
    @Published private(set) var contextTokens: Int?
    /// History is being (re)fetched. events is kept, not cleared, so the UI can show
    /// that it is syncing in the background while displaying the cache
    @Published private(set) var isSyncing = false
    @Published var errorBanner: String?
    /// Boundary above which events count as "just arrived".
    /// Prevents the accident where a bulk history load makes every row animate in
    /// at once; start() sets it to "max history id + 1" right after pouring in the
    /// history. Initial .max = nothing is new (no animation)
    @Published private(set) var animateFrom = Int.max

    /// Presents as "running" including right after the send tap (before turn_started arrives)
    var isBusy: Bool { isRunning || !pendingSends.isEmpty }

    /// Whether it qualifies for the appear effect (rows on screen from the start as history do not)
    func isNewlyArrived(_ eventId: Int) -> Bool { eventId >= animateFrom }

    private let backend: TinyBackend
    private let sessionId: String
    private var streamTask: Task<Void, Never>?
    private var cliLiveTask: Task<Void, Never>?

    init(backend: TinyBackend, session: SessionRecord) {
        self.backend = backend
        self.sessionId = session.id
        self.isRunning = session.status == .running
        self.isDetached = session.status == .detached
        self.isHeldByCLI = session.isHeldByCLI
    }

    /// Two-stage setup: history via REST, live via WS (avoids the drop window
    /// between the WS backlog and live — the gap between ws.ts's listSince and
    /// its on("event") registration)
    func start() {
        streamTask?.cancel()
        isSyncing = true
        startCliLivePolling()
        streamTask = Task {
            defer { isSyncing = false }
            do {
                let history = try await backend.events(sessionId: sessionId, since: 0)
                guard !Task.isCancelled else { return }
                events = history
                // Everything up to here was "on screen from the start". Only later WS arrivals animate
                animateFrom = (history.map(\.id).max() ?? 0) + 1
                pendingSends.removeAll()   // the real ones are in the history now, so drop the placeholders
                isSyncing = false
                recomputeRunning()
                await reconcilePending()
                let lastId = history.map(\.id).max() ?? 0
                for await ev in backend.eventStream(sessionId: sessionId, since: lastId) {
                    guard !Task.isCancelled else { return }
                    handle(ev)
                }
            } catch {
                if Task.isCancelled { return }
                if error is CancellationError { return }
                if let urlError = error as? URLError, urlError.code == .cancelled { return }
                errorBanner = "Failed to load history: \(error.localizedDescription)"
            }
        }
    }

    func stop() {
        streamTask?.cancel(); streamTask = nil
        cliLiveTask?.cancel(); cliLiveTask = nil
    }

    /// No WS push exists for cliLive (unlike sessionStateChanged for isDetached), so poll it at the
    /// same 4s cadence SessionListView already uses for the session list. Keeps the composer's
    /// lock in sync with the Mac's CLI in both directions while the chat stays open
    private func startCliLivePolling() {
        cliLiveTask?.cancel()
        cliLiveTask = Task {
            while !Task.isCancelled {
                await refreshCliLive()
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    func refreshCliLive() async {
        guard let list = try? await backend.sessions(),
              let match = list.first(where: { $0.id == sessionId }) else { return }
        isHeldByCLI = match.isHeldByCLI
    }

    /// Apply one event arriving over WS (also directly callable from tests)
    func handle(_ ev: EventRecord) {
        guard !events.contains(where: { $0.id == ev.id }) else { return }   // dedupe across reconnects
        events.append(ev)
        switch ev.event {
        case .userMessage(let text, _, _):
            // Swap the optimistic placeholder for the real one. Prefer a text match,
            // but drop the oldest even without a match (never leave double-display debris from a missed match)
            if let i = pendingSends.firstIndex(where: { $0.text == text }) {
                pendingSends.remove(at: i)
            } else if !pendingSends.isEmpty {
                pendingSends.removeFirst()
            }
        case .turnStarted: isRunning = true
        case .turnCompleted(_, _, let ctx):
            isRunning = false
            pendingSends.removeAll()   // safety net: clear all debris at turn end
            if let ctx { contextTokens = ctx }
        case .turnFailed, .authError:
            isRunning = false
            pendingSends.removeAll()
        case .permissionRequested(let reqId, let tool, let input):
            pending.append(PendingPermission(id: reqId, sessionId: sessionId, toolName: tool,
                                             input: input, requestedAt: ev.createdAt))
        case .permissionResolved(let reqId, _, _):
            pending.removeAll { $0.id == reqId }
        case .sessionStateChanged(let status):
            isDetached = status == "detached"
        default: break
        }
    }

    /// The CLI (tiny attach) leaves the session detached without resuming it, so take it back from the app
    func resumeFromCLI() async {
        do {
            try await backend.setDetached(sessionId: sessionId, detached: false)
            errorBanner = nil
        } catch {
            errorBanner = error.localizedDescription
        }
    }

    private func recomputeRunning() {
        // Infer the current running state by scanning from the end of history for
        // turn start/end. Pick up the latest contextTokens along the way
        var running: Bool?
        for ev in events.reversed() {
            switch ev.event {
            case .turnStarted:
                if running == nil { running = true }
            case .turnCompleted(_, _, let ctx):
                if running == nil { running = false }
                if let ctx {
                    contextTokens = ctx
                    isRunning = running ?? false
                    return
                }
            case .turnFailed, .authError:
                if running == nil { running = false }
            default: continue
            }
        }
        isRunning = running ?? false
    }

    /// Pending permissions live only in server memory (gone on restart or timeout).
    /// Trusting event history alone would show buttons for unresolvable permissions,
    /// so reconcile against GET /v1/sessions/:id/permissions as the source of truth
    func reconcilePending() async {
        pending = (try? await backend.pendingPermissions(sessionId: sessionId)) ?? []
    }

    /// Stack only the optimistic display, **synchronously** (pass the return value to deliver).
    /// Stacking via a Task delays the update by a frame or more, and overlapping the
    /// concurrent keyboard-dismiss animation it reads as "lag before Running appears"
    /// (device feedback). Call this directly from the send button's tap handler
    func beginSend(prompt: String, thumbnails: [UIImage] = []) -> OptimisticSend {
        let placeholder = OptimisticSend(text: prompt, thumbnails: thumbnails)
        pendingSends.append(placeholder)
        return placeholder
    }

    /// Actually send the optimistic display stacked by beginSend. Returns false = send failed
    /// (the caller may restore the draft; the placeholder is rolled back here)
    @discardableResult
    func deliver(_ placeholder: OptimisticSend, prompt: String,
                 images: [TurnImageAttachment] = []) async -> Bool {
        do {
            try await backend.sendTurn(sessionId: sessionId, prompt: prompt, images: images)
            errorBanner = nil
            return true
        } catch let e as APIError where e.status == 409 {
            pendingSends.removeAll { $0.id == placeholder.id }
            errorBanner = e.message == "session is attached from CLI"
                ? "In use by CLI (tiny attach)" : "A turn is already running"
        } catch {
            pendingSends.removeAll { $0.id == placeholder.id }
            errorBanner = error.localizedDescription
        }
        return false
    }

    /// One-shot stack-then-send variant (for tests and the demo path; UI uses beginSend/deliver)
    @discardableResult
    func send(prompt: String, images: [TurnImageAttachment] = []) async -> Bool {
        let placeholder = beginSend(prompt: prompt,
                                    thumbnails: images.compactMap { UIImage(data: $0.data) })
        return await deliver(placeholder, prompt: prompt, images: images)
    }

    func interrupt() async {
        try? await backend.interrupt(sessionId: sessionId)
    }

    func respond(reqId: String, allow: Bool, updatedInput: JSONValue? = nil) async {
        do {
            try await backend.respondPermission(reqId: reqId, allow: allow, message: nil,
                                                updatedInput: updatedInput)
        } catch let e as APIError where e.status == 404 {
            // Already resolved, timed out, or after a tinyd restart — all land on this 404
            errorBanner = "This permission request is no longer valid (timed out or already answered)"
            await reconcilePending()
        } catch {
            errorBanner = error.localizedDescription
        }
    }

    func fileData(fileId: String) async throws -> (data: Data, mime: String) {
        try await backend.fileData(fileId: fileId)
    }

    /// Thumbnail fetch for user-attached images (with an in-memory cache; re-fetching
    /// on every redraw makes scrolling wait on the network)
    private var attachedImageCache: [String: UIImage] = [:]

    func attachedImage(fileId: String) async -> UIImage? {
        if let cached = attachedImageCache[fileId] { return cached }
        guard let (data, _) = try? await backend.fileData(fileId: fileId),
              let image = UIImage(data: data) else { return nil }
        attachedImageCache[fileId] = image
        return image
    }
}
