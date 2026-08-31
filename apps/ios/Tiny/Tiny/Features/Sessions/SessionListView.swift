import SwiftUI

struct SessionListView: View {
    @EnvironmentObject var model: AppModel
    // List data is cached in AppModel (model.sessions / model.sessionsLoaded).
    // Leaving the screen or app and coming back shows the previous content instantly,
    // with the re-fetch running in the background
    @State private var loadError: String?
    @State private var archiveError: String?
    @State private var showNew = false
    @State private var showSettings = false
    @State private var showUsage = false
    @State private var path = NavigationPath()
    // Sheets do not inherit the parent's .preferredColorScheme, so apply it to each sheet individually
    @AppStorage("appearance") private var appearanceRaw = Appearance.system.rawValue

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                // Full-screen connection error only when there is no cache. With a cache,
                // keep showing the previous list (switching to a full-screen error flickers)
                if let err = loadError, model.sessions.isEmpty {
                    ContentUnavailableView {
                        Label("Can't connect", systemImage: "wifi.slash")
                    } description: {
                        Text(err + "\nCheck the tinyd and Tailscale connection on your Mac.")
                    } actions: {
                        Button("Retry") { Task { await reload() } }
                    }
                } else if !model.sessionsLoaded {
                    // First fetch in progress. Showing nothing would look like "no sessions"
                    ProgressView("Loading sessions…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if model.sessions.isEmpty {
                    ContentUnavailableView {
                        Label("No sessions", systemImage: "bubble.left.and.bubble.right")
                    } description: {
                        Text("Tap + to start a new session.")
                    }
                } else {
                    List(model.sessions) { s in
                        // Card-style swipe (SwipeActionCard). The whole card slides,
                        // so the background lives on the card, not listRowBackground
                        SwipeActionCard(
                            icon: "archivebox",
                            tint: .tInkSub,
                            // Disabled while running or attached to the CLI to prevent accidents (the server also returns 409)
                            enabled: s.status != .running && s.status != .detached,
                            action: { archive(s) }
                        ) {
                            ZStack {
                                row(s)
                                    .padding(.vertical, 12)
                                    .padding(.horizontal, 14)
                                    .background(Color.tCard, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                                // Navigation goes through a transparent NavigationLink (no chevron,
                                // keeping the card's look aligned with the reference apps)
                                NavigationLink(value: s) { EmptyView() }.opacity(0)
                            }
                        }
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .background(Color.tBg)
                    .refreshable { await reload() }
                }
            }
            .background(Color.tBg)
            // First fetch + keeping the running spinners and unread dots fresh
            // (4-second polling only while visible). From the second appearance on,
            // the cache stays up while updating in the background
            .task {
                await reload()
                model.sessionsLoaded = true
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 4_000_000_000)
                    await reload()
                }
            }
            .navigationTitle(model.backend?.isDemo == true ? "Sessions (Demo)" : "Sessions")
            .navigationDestination(for: SessionRecord.self) { s in
                ChatView(session: s)
                    .onAppear { ReadMarks.markOpened(s.id) }
                    .onDisappear { ReadMarks.markOpened(s.id) }   // also mark progress made while viewing as read
            }
            .navigationDestination(for: ArchivedRoute.self) { _ in
                ArchivedSessionsView()
            }
            .toolbar {
                ToolbarItemGroup(placement: .topBarLeading) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                    Button { showUsage = true } label: { Image(systemName: "gauge.with.needle") }
                        .accessibilityIdentifier("usageButton")
                    Button { path.append(ArchivedRoute()) } label: { Image(systemName: "archivebox") }
                        .accessibilityIdentifier("archivedButton")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showNew = true } label: { Image(systemName: "plus") }
                        .accessibilityIdentifier("newSessionButton")
                }
            }
            .sheet(isPresented: $showNew) {
                NewSessionSheet(fallbackCwds: recentCwds) { created in
                    model.sessions.insert(created, at: 0)
                    path.append(created)
                }
                .preferredColorScheme(Appearance(rawValue: appearanceRaw)?.colorScheme)
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
                    .preferredColorScheme(Appearance(rawValue: appearanceRaw)?.colorScheme)
            }
            .sheet(isPresented: $showUsage) {
                UsageView()
                    .preferredColorScheme(Appearance(rawValue: appearanceRaw)?.colorScheme)
            }
            // Navigation from a push tap (Task 12). Must not crash when the sessionId is not in the list
            .onReceive(NotificationCenter.default.publisher(for: .tinyOpenSession)) { note in
                guard let sid = note.userInfo?["sessionId"] as? String else { return }
                if let s = model.sessions.first(where: { $0.id == sid }) {
                    path.append(s)
                    return
                }
                // For a sessionId not yet in the list (e.g. right after a background
                // launch), reload and look exactly once more. If still absent, do
                // nothing (don't crash on nonexistent IDs like push-test)
                Task {
                    await reload()
                    if let s = model.sessions.first(where: { $0.id == sid }) {
                        path.append(s)
                    }
                }
            }
            .alert("Couldn't archive", isPresented: .init(
                get: { archiveError != nil }, set: { if !$0 { archiveError = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(archiveError ?? "")
            }
        }
    }

    private func archive(_ s: SessionRecord) {
        guard let backend = model.backend else { return }
        // Without withAnimation the row vanishes instantly. Keep the default curve
        // (the system composes it with the destructive swipe's slide, so no explicit curve)
        _ = withAnimation {
            model.sessions.removeAll { $0.id == s.id }
        }
        Task {
            do {
                _ = try await backend.setArchived(sessionId: s.id, archived: true)
            } catch {
                archiveError = error.localizedDescription
                await reload()   // bring the row back
            }
        }
    }

    private func row(_ s: SessionRecord) -> some View {
        HStack(spacing: 10) {
            // Unread dot (the spinner wins while running — from either side)
            if s.isBusy {
                ProgressView().controlSize(.small)
            } else if ReadMarks.isUnread(s) {
                Circle().fill(Color.tTint).frame(width: 9, height: 9)
                    .accessibilityLabel("Unread")
            } else {
                Circle().fill(.clear).frame(width: 9, height: 9)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(s.displayTitle).font(.tinyHeadline).lineLimit(1)
                    Spacer()
                    if s.isHeldByCLI {
                        Text("CLI")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.secondary.opacity(0.15), in: Capsule())
                    }
                    // A turn the CLI is running on its own is "Running" all the same
                    statusBadge(s.isBusy ? .running : s.status)
                }
                HStack(spacing: 4) {
                    Text("\(s.profile) · \((s.cwd as NSString).lastPathComponent)")
                        .font(.caption).fontDesign(.monospaced).foregroundStyle(Color.tInkSub).lineLimit(1)
                    Spacer()
                    Text(Self.relativeTime(s.updatedAt))
                        .font(.caption2).fontDesign(.monospaced).foregroundStyle(Color.tInkSub)
                }
            }
        }
    }

    /// updatedAt (ISO8601) as relative time ("3m ago" etc.). Older than a week shows the date
    static func relativeTime(_ iso: String) -> String {
        guard let date = EventRow.parseISO(iso) else { return "" }
        if Date().timeIntervalSince(date) > 7 * 24 * 3600 {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US")
            f.dateFormat = "M/d"
            return f.string(from: date)
        }
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: "en_US")
        f.unitsStyle = .abbreviated
        return f.localizedString(for: date, relativeTo: Date())
    }

    private func statusBadge(_ st: SessionStatus) -> some View {
        let (text, color): (String, Color) = switch st {
        case .idle: ("Idle", .tInkSub)
        case .running: ("Running", .tRunning)
        case .detached: ("In CLI", .tDetached)
        case .interrupted: ("Interrupted", .tRuby)
        }
        return Text(text).font(.tinyCaption2).padding(.horizontal, 8).padding(.vertical, 2)
            .background(color.opacity(0.15)).foregroundStyle(color).clipShape(Capsule())
    }

    /// cwds from the normal list (newest first, deduplicated). Initial candidates for the new-session sheet and the fallback when server history is unavailable
    private var recentCwds: [String] {
        var seen = Set<String>()
        return model.sessions.compactMap { seen.insert($0.cwd).inserted ? $0.cwd : nil }
    }

    private func reload() async {
        guard let backend = model.backend else { return }
        do {
            model.sessions = try await backend.sessions()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}

/// NavigationPath route to the Archived screen (distinguished from SessionRecord by type)
struct ArchivedRoute: Hashable {}

extension Notification.Name {
    static let tinyOpenSession = Notification.Name("tinyOpenSession")
}

/// Read tracking. Keeps the last-opened time in UserDefaults;
/// unread (blue dot) when session.updatedAt is newer.
enum ReadMarks {
    private static func key(_ id: String) -> String { "lastOpened.\(id)" }

    static func markOpened(_ id: String) {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: key(id))
    }

    static func isUnread(_ s: SessionRecord) -> Bool {
        guard let updated = EventRow.parseISO(s.updatedAt) else { return false }
        let opened = UserDefaults.standard.double(forKey: key(s.id))
        guard opened > 0 else { return updated.timeIntervalSinceNow > -7 * 24 * 3600 }  // recent ones never opened
        return updated.timeIntervalSince1970 > opened
    }
}
