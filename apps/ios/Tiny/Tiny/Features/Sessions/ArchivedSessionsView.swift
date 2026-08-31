import SwiftUI

/// List of archived sessions. Viewing and Unarchive (restore) only.
/// Archived sessions don't move, so no polling — initial fetch + pull-to-refresh only.
struct ArchivedSessionsView: View {
    @EnvironmentObject var model: AppModel
    @State private var sessions: [SessionRecord] = []
    @State private var loaded = false
    @State private var loadError: String?

    var body: some View {
        Group {
            if let err = loadError, sessions.isEmpty {
                ContentUnavailableView {
                    Label("Can't connect", systemImage: "wifi.slash")
                } description: {
                    Text(err)
                } actions: {
                    Button("Retry") { Task { await reload() } }
                }
            } else if !loaded {
                ProgressView("Loading…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if sessions.isEmpty {
                ContentUnavailableView {
                    Label("No archived sessions", systemImage: "archivebox")
                } description: {
                    Text("Swipe a session left in the list to archive it.")
                }
            } else {
                List(sessions) { s in
                    // Card-style swipe (SwipeActionCard). Same manner as SessionListView
                    SwipeActionCard(
                        icon: "tray.and.arrow.up",
                        tint: .tTint,
                        action: { unarchive(s) }
                    ) {
                        ZStack {
                            row(s)
                                .padding(.vertical, 12)
                                .padding(.horizontal, 14)
                                .background(Color.tCard, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
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
        .navigationTitle("Archived")
        .task { await reload() }
    }

    private func row(_ s: SessionRecord) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(s.displayTitle).font(.tinyHeadline).lineLimit(1)
            HStack(spacing: 4) {
                Text("\(s.profile) · \((s.cwd as NSString).lastPathComponent)")
                    .font(.caption).fontDesign(.monospaced).foregroundStyle(Color.tInkSub).lineLimit(1)
                Spacer()
                Text(SessionListView.relativeTime(s.updatedAt))
                    .font(.caption2).fontDesign(.monospaced).foregroundStyle(Color.tInkSub)
            }
        }
    }

    private func unarchive(_ s: SessionRecord) {
        guard let backend = model.backend else { return }
        // Without withAnimation the row vanishes instantly. Keep the default curve
        // (the system composes it with the destructive swipe's slide, so no explicit curve)
        _ = withAnimation {
            sessions.removeAll { $0.id == s.id }
        }
        Task {
            do {
                _ = try await backend.setArchived(sessionId: s.id, archived: false)
            } catch {
                loadError = error.localizedDescription
                await reload()   // bring the row back
            }
        }
    }

    private func reload() async {
        guard let backend = model.backend else { return }
        do {
            sessions = try await backend.archivedSessions()
            loaded = true
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}
