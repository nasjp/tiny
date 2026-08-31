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
    @State private var failures: [String: UsageFailure] = [:]
    @State private var loading = true
    /// Profiles whose raw error the reader has opened (Details)
    @State private var expandedDetails: Set<String> = []

    var body: some View {
        NavigationStack {
            List {
                if loading && usages.isEmpty && failures.isEmpty {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
                ForEach(sortedLoggedIn) { profile in
                    Section("\(profile.name) · \(profile.agentLabel)") {
                        if let usage = usages[profile.name] {
                            ForEach(usage.limits) { limit in
                                limitRow(limit)
                            }
                        } else if let failure = failures[profile.name] {
                            failureRow(profile.name, failure)
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

    /// One line saying what is wrong, the command that fixes it, and the raw text behind Details
    @ViewBuilder
    private func failureRow(_ profile: String, _ failure: UsageFailure) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if failure.tone == .alert {
                Label(failure.title, systemImage: "exclamationmark.triangle.fill")
                    .font(.tinyCallout)
                    .foregroundStyle(Color.tRuby)
            } else {
                // Not an error, so it does not get error weight: an aside in the profile's own card
                Text(failure.title).font(.tinyCaption).foregroundStyle(Color.tInkSub)
            }
            if let hint = failure.hint {
                // The fix is a command for the Mac, so it reads (and copies) as one
                Text(hint)
                    .font(.tinyCaption).fontDesign(.monospaced)
                    .foregroundStyle(Color.tInk)
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.tBg))
                    .copyable(hint)
            }
            if let detail = failure.detail {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        if expandedDetails.contains(profile) { expandedDetails.remove(profile) }
                        else { expandedDetails.insert(profile) }
                    }
                } label: {
                    Label("Details", systemImage: expandedDetails.contains(profile) ? "chevron.down" : "chevron.right")
                        .font(.tinyCaption).foregroundStyle(Color.tInkSub)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("usageDetailsToggle")
                if expandedDetails.contains(profile) {
                    Text(detail)
                        .font(.tinyCaption2).fontDesign(.monospaced)
                        .foregroundStyle(Color.tInkSub)
                        .copyable(detail)
                }
            }
        }
        .padding(.vertical, 2)
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
                case .success(let u): usages[name] = u; failures[name] = nil
                case .failure(let e): failures[name] = UsageFailure.from(e)
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
