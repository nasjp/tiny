import SwiftUI

/// List of archived sessions. Viewing and Unarchive (restore) only — one row by swipe, or several
/// at once through the same selection mode as the main list (so a bulk archive is undone in one go).
/// Archived sessions don't move, so no polling — initial fetch + pull-to-refresh only.
struct ArchivedSessionsView: View {
    @EnvironmentObject var model: AppModel
    @State private var sessions: [SessionRecord] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var selecting = false
    @State private var selection = SessionSelection()

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
                        enabled: !selecting,
                        action: { unarchive([s.id]) }
                    ) {
                        ZStack {
                            row(s)
                                .padding(.vertical, 12)
                                .padding(.horizontal, 14)
                                .background(Color.tCard, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                                .contentShape(Rectangle())
                                // In selection mode a tap ticks the row; otherwise the gesture stays out of the way
                                .simultaneousGesture(TapGesture().onEnded { selection.toggle(s.id) },
                                                     including: selecting ? .all : .subviews)
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
        .navigationTitle("Archived")
        .toolbar {
            if selecting {
                ToolbarItem(placement: .topBarLeading) {
                    Button(selection.allSelected(among: sessions) ? "Deselect All" : "Select All") {
                        if selection.allSelected(among: sessions) { selection.clear() } else { selection.selectAll(sessions) }
                    }
                    .accessibilityIdentifier("selectAllButton")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { endSelecting() }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("doneSelectingButton")
                }
                ToolbarItemGroup(placement: .bottomBar) {
                    Spacer()
                    Button { unarchive(chosenIds) } label: {
                        Label(BulkSessionAction.buttonTitle(verb: "Unarchive", count: chosenIds.count),
                              systemImage: "tray.and.arrow.up")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.tTint)
                    .disabled(chosenIds.isEmpty)
                    .accessibilityIdentifier("bulkUnarchiveButton")
                    Spacer()
                }
            } else {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Select") { beginSelecting() }
                        .disabled(sessions.isEmpty)
                        .accessibilityIdentifier("selectButton")
                }
            }
        }
        .alert("Couldn't unarchive", isPresented: .init(
            get: { actionError != nil }, set: { if !$0 { actionError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
        .task { await reload() }
    }

    private func row(_ s: SessionRecord) -> some View {
        HStack(spacing: 10) {
            if selecting {
                SelectionMark(id: s.id, selected: selection.contains(s.id))
                    .transition(.scale.combined(with: .opacity))
            }
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
    }

    /// Every archived row can be restored, so the only pruning is rows that left the list
    private var chosenIds: [String] { selection.chosen(from: sessions, where: { _ in true }) }

    private func beginSelecting(with s: SessionRecord? = nil) {
        selection.clear()
        if let s { selection.select(s.id) }
        withAnimation(.tinyAppear) { selecting = true }
    }

    private func endSelecting() {
        withAnimation(.tinyAppear) { selecting = false }
        selection.clear()
    }

    /// One row from a swipe, or every ticked row from the bottom bar — the same path either way
    private func unarchive(_ ids: [String]) {
        guard let backend = model.backend, !ids.isEmpty else { return }
        let gone = Set(ids)
        // Without withAnimation the rows vanish instantly. Keep the default curve
        // (the system composes it with the destructive swipe's slide, so no explicit curve)
        _ = withAnimation {
            sessions.removeAll { gone.contains($0.id) }
        }
        if selecting { endSelecting() }
        Task {
            let failures = await BulkSessionAction.run(ids) {
                _ = try await backend.setArchived(sessionId: $0, archived: false)
            }
            if !failures.isEmpty {
                actionError = BulkSessionAction.failureMessage(verb: "unarchive", failures: failures, total: ids.count)
                await reload()   // bring the failed rows back (the others are restored for real)
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
