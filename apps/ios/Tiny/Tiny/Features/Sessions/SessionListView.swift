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
    // Selection mode: pick several rows, then archive them from the bottom bar
    @State private var selecting = false
    @State private var selection = SessionSelection()
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
                            // Disabled while running or attached to the CLI to prevent accidents (the server
                            // also returns 409), and while selecting (a tap picks the row instead)
                            enabled: !selecting && s.canArchive,
                            action: { archive([s.id]) }
                        ) {
                            ZStack {
                                row(s)
                                    .padding(.vertical, 12)
                                    .padding(.horizontal, 14)
                                    .background(Color.tCard, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                                    .contentShape(Rectangle())
                                    // In selection mode a tap ticks the row. The mask keeps the gesture
                                    // out of the way otherwise, so the row's navigation is untouched
                                    .simultaneousGesture(TapGesture().onEnded { toggle(s) },
                                                         including: selecting ? .all : .subviews)
                                // Navigation goes through a transparent NavigationLink (no chevron,
                                // keeping the card's look aligned with the reference apps). Absent while
                                // selecting, so a tap cannot navigate away
                                if !selecting {
                                    NavigationLink(value: s) { EmptyView() }.opacity(0)
                                }
                            }
                            .contextMenu {
                                if !selecting {
                                    Button { beginSelecting(with: s) } label: {
                                        Label("Select", systemImage: "checkmark.circle")
                                    }
                                }
                            }
                            .accessibilityAddTraits(selecting && selection.contains(s.id) ? .isSelected : [])
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
                if selecting {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(selection.allSelected(among: archivable) ? "Deselect All" : "Select All") {
                            toggleSelectAll()
                        }
                        .disabled(archivable.isEmpty)
                        .accessibilityIdentifier("selectAllButton")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { endSelecting() }
                            .fontWeight(.semibold)
                            .accessibilityIdentifier("doneSelectingButton")
                    }
                    ToolbarItemGroup(placement: .bottomBar) {
                        Spacer()
                        Button { archive(chosenIds) } label: {
                            // Not a Label: toolbars draw those icon-only, and the count is the point of this button
                            HStack(spacing: 6) {
                                Image(systemName: "archivebox")
                                Text(BulkSessionAction.buttonTitle(verb: "Archive", count: chosenIds.count))
                            }
                            .font(.tinyHeadline)
                            .padding(.horizontal, 6)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.tTint)
                        .disabled(chosenIds.isEmpty)
                        .accessibilityIdentifier("bulkArchiveButton")
                        Spacer()
                    }
                } else {
                    ToolbarItemGroup(placement: .topBarLeading) {
                        Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        Button { showUsage = true } label: { Image(systemName: "gauge.with.needle") }
                            .accessibilityIdentifier("usageButton")
                        Button { path.append(ArchivedRoute()) } label: { Image(systemName: "archivebox") }
                            .accessibilityIdentifier("archivedButton")
                    }
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button("Select") { beginSelecting() }
                            .disabled(model.sessions.isEmpty)
                            .accessibilityIdentifier("selectButton")
                        Button { showNew = true } label: { Image(systemName: "plus") }
                            .accessibilityIdentifier("newSessionButton")
                    }
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

    /// Rows that selection mode can pick (the same rule as the swipe)
    private var archivable: [SessionRecord] { model.sessions.filter(\.canArchive) }
    /// What "Archive N Sessions" would act on right now
    private var chosenIds: [String] { selection.chosen(from: model.sessions, where: \.canArchive) }

    private func beginSelecting(with s: SessionRecord? = nil) {
        selection.clear()
        if let s, s.canArchive { selection.select(s.id) }
        withAnimation(.tinyAppear) { selecting = true }
    }

    private func endSelecting() {
        withAnimation(.tinyAppear) { selecting = false }
        selection.clear()
    }

    private func toggle(_ s: SessionRecord) {
        guard s.canArchive else { return }
        selection.toggle(s.id)
    }

    private func toggleSelectAll() {
        if selection.allSelected(among: archivable) { selection.clear() } else { selection.selectAll(archivable) }
    }

    /// One row from a swipe, or every ticked row from the bottom bar — the same path either way
    private func archive(_ ids: [String]) {
        guard let backend = model.backend, !ids.isEmpty else { return }
        let gone = Set(ids)
        // Without withAnimation the rows vanish instantly. Keep the default curve
        // (the system composes it with the destructive swipe's slide, so no explicit curve)
        _ = withAnimation {
            model.sessions.removeAll { gone.contains($0.id) }
        }
        if selecting { endSelecting() }
        Task {
            let failures = await BulkSessionAction.run(ids) {
                _ = try await backend.setArchived(sessionId: $0, archived: true)
            }
            if !failures.isEmpty {
                archiveError = BulkSessionAction.failureMessage(verb: "archive", failures: failures, total: ids.count)
                await reload()   // bring the failed rows back (the others are archived for real)
            }
        }
    }

    private func row(_ s: SessionRecord) -> some View {
        HStack(spacing: 10) {
            // Selection tick, otherwise the unread dot (the spinner wins while running — from either side)
            if selecting {
                SelectionMark(id: s.id, selected: selection.contains(s.id), enabled: s.canArchive)
                    .transition(.scale.combined(with: .opacity))
            } else if s.isBusy {
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
                    // A turn the CLI is running on its own is "Running" all the same; a CLI that
                    // closed the session shows "Closed" until the phone sends or the CLI resumes
                    statusBadge(s.listBadge)
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

    private func statusBadge(_ badge: ListBadge) -> some View {
        let (text, color): (String, Color) = switch badge {
        case .idle: ("Idle", .tInkSub)
        case .running: ("Running", .tRunning)
        case .inCLI: ("In CLI", .tDetached)
        case .interrupted: ("Interrupted", .tRuby)
        case .closed: ("Closed", .tDetached)
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
