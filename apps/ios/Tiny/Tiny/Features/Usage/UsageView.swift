import SwiftUI

/// Shows the equivalent of Claude Code's /usage per profile.
/// Session (5-hour), weekly, and per-model utilization plus reset times.
struct UsageView: View {
    /// When set, that profile is shown first (when opened from the chat screen)
    var focusProfile: String? = nil
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var profiles: [ProfileInfo] = []
    @State private var usages: [String: ProfileUsage] = [:]
    @State private var errors: [String: String] = [:]
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
                if loading && usages.isEmpty && errors.isEmpty {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
                ForEach(sortedLoggedIn) { profile in
                    Section("\(profile.name) · \(profile.agentLabel)") {
                        if let usage = usages[profile.name] {
                            ForEach(usage.limits) { limit in
                                limitRow(limit)
                            }
                        } else if let err = errors[profile.name] {
                            Text(err).font(.caption).foregroundStyle(Color.tRuby)
                        } else {
                            ProgressView()
                        }
                    }
                    .listRowBackground(Color.tCard)
                }
                if !profiles.filter({ !$0.loggedIn }).isEmpty {
                    Section {
                        ForEach(profiles.filter { !$0.loggedIn }) { p in
                            Text("\(p.name) · \(p.agentLabel) (not logged in)").foregroundStyle(Color.tInkSub)
                        }
                    }
                    .listRowBackground(Color.tCard)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.tBg)
            .navigationTitle("Usage")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await reload() }
            .task { await reload() }
        }
    }

    /// focusProfile (the open session's profile) first
    private var sortedLoggedIn: [ProfileInfo] {
        // Agents without usage (server sends features.usage=false) are not shown
        let logged = profiles.filter { $0.loggedIn && $0.supportsUsage }
        guard let focus = focusProfile else { return logged }
        return logged.sorted { a, b in
            if a.name == focus { return true }
            if b.name == focus { return false }
            return a.name < b.name
        }
    }

    private func limitRow(_ limit: UsageLimit) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(limit.label).font(.tinyCallout)
                Spacer()
                Text("\(Int(limit.percent))%")
                    .font(.callout.monospacedDigit().bold())
                    .fontDesign(.monospaced)
                    .foregroundStyle(color(for: limit.percent))
            }
            ProgressView(value: min(limit.percent, 100), total: 100)
                .tint(color(for: limit.percent))
            if let resetsAt = limit.resetsAt {
                Text("Resets: \(Self.resetText(resetsAt))")
                    .font(.tinyCaption2).fontDesign(.monospaced).foregroundStyle(Color.tInkSub)
            }
        }
        .padding(.vertical, 2)
    }

    private func color(for percent: Double) -> Color {
        switch percent {
        case ..<50: .tRunning
        case ..<80: .tDetached
        default: .tRuby
        }
    }

    /// Renders reset times like "Today 18:00" or "9/3 11:00 (in 3 days)"
    static func resetText(_ iso: String) -> String {
        guard let date = EventRow.parseISO(iso) else { return iso }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = Calendar.current.isDateInToday(date) ? "'Today' HH:mm" : "M/d HH:mm"
        let base = f.string(from: date)
        let rel = RelativeDateTimeFormatter()
        rel.locale = Locale(identifier: "en_US")
        rel.unitsStyle = .abbreviated
        return "\(base) (\(rel.localizedString(for: date, relativeTo: Date())))"
    }

    private func reload() async {
        guard let backend = model.backend else { return }
        loading = true
        defer { loading = false }
        profiles = (try? await backend.profiles()) ?? []
        await withTaskGroup(of: (String, Result<ProfileUsage, Error>).self) { group in
            for p in profiles where p.loggedIn {
                group.addTask { (p.name, await Result { try await backend.profileUsage(name: p.name) }) }
            }
            for await (name, result) in group {
                switch result {
                case .success(let u): usages[name] = u; errors[name] = nil
                case .failure(let e): errors[name] = e.localizedDescription
                }
            }
        }
    }
}

private extension Result where Failure == Error {
    init(catching body: () async throws -> Success) async {
        do { self = .success(try await body()) } catch { self = .failure(error) }
    }
}
