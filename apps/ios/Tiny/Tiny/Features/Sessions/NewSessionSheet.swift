import SwiftUI

struct NewSessionSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    /// cwd candidates derived from the normal list. Fallback when server history (`/v1/cwds`) is unavailable (old tinyd, etc.)
    let fallbackCwds: [String]
    let onCreated: (SessionRecord) -> Void

    @State private var profiles: [ProfileInfo] = []
    @State private var profile = ""
    @State private var cwd = ""
    @State private var mode: PermissionMode = .default
    @State private var modelChoice = ""    // "" = CLI default
    @State private var effortChoice = ""   // "" = CLI default
    @State private var error: String?
    @State private var busy = false
    /// Tap-to-fill candidates. Overwritten by server history (which includes archived cwds)
    @State private var recentCwds: [String] = []

    init(fallbackCwds: [String], onCreated: @escaping (SessionRecord) -> Void) {
        self.fallbackCwds = fallbackCwds
        self.onCreated = onCreated
        _recentCwds = State(initialValue: fallbackCwds)
    }

    var body: some View {
        NavigationStack {
            Form {
                if model.backend?.isDemo == true {
                    Text("You can't create new sessions in demo mode. In the real app, you start by specifying a working directory on your Mac.")
                        .font(.tinyFootnote).foregroundStyle(Color.tInkSub)
                }
                Section("Profile") {
                    Picker("Profile", selection: $profile) {
                        ForEach(profiles) { p in
                            Text("\(p.name) · \(p.agentLabel)\(p.loggedIn ? "" : " (not logged in)")")
                                .tag(p.name)
                        }
                    }
                }
                .listRowBackground(Color.tCard)
                Section("Working directory") {
                    TextField("/Users/you/src/repo", text: $cwd)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL)   // path-friendly: symbols closer at hand than the space bar
                    if !recentCwds.isEmpty {
                        ForEach(recentCwds, id: \.self) { path in
                            Button {
                                cwd = path
                            } label: {
                                HStack {
                                    Image(systemName: "clock.arrow.circlepath")
                                        .font(.caption).foregroundStyle(Color.tInkSub)
                                    Text(path).font(.tinyCallout).fontDesign(.monospaced)
                                        .lineLimit(1).truncationMode(.head)
                                }
                            }
                            .foregroundStyle(Color.tInk)
                        }
                    }
                }
                .listRowBackground(Color.tCard)
                Section {
                    Picker("Model", selection: $modelChoice) {
                        Text("Default (\(selectedProfile?.defaultModel ?? "auto"))").tag("")
                        ForEach(selectedProfile?.modelChoices ?? []) { Text($0.displayName).tag($0.id) }
                    }
                } header: {
                    Text("Model")
                } footer: {
                    Text("Default reads the profile's settings.json; \"auto\" means the CLI picks the model.")
                }
                .listRowBackground(Color.tCard)
                if !(selectedProfile?.effortChoices ?? []).isEmpty {
                    Section("Reasoning effort") {
                        Picker("Effort", selection: $effortChoice) {
                            Text("Default (\(selectedProfile?.defaultEffort ?? "high"))").tag("")
                            ForEach(selectedProfile?.effortChoices ?? [], id: \.self) { Text($0).tag($0) }
                        }
                    }
                    .listRowBackground(Color.tCard)
                }
                Section("Permission mode") {
                    Picker("Permission mode", selection: $mode) {
                        ForEach(permissionModeChoices) { Text($0.label).tag(PermissionMode(rawValue: $0.id)) }
                    }.pickerStyle(.inline).labelsHidden()
                }
                .listRowBackground(Color.tCard)
                if let error { Text(error).font(.tinyFootnote).foregroundStyle(Color.tRuby) }
            }
            .scrollContentBackground(.hidden)
            .background(Color.tBg)
            .navigationTitle("New Session")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }
                        .disabled(profile.isEmpty || trimmedCwd.isEmpty || busy || model.backend?.isDemo == true)
                }
            }
            .task {
                profiles = (try? await model.backend?.profiles()) ?? []
                if let cwds = try? await model.backend?.recentCwds(), !cwds.isEmpty {
                    recentCwds = cwds
                }
                if profile.isEmpty { profile = profiles.first(where: \.loggedIn)?.name ?? profiles.first?.name ?? "" }
                restoreLastChoices()
            }
            // On switching profile (= agent), reset choices the new agent doesn't offer back to defaults
            .onChange(of: profile) { _, _ in restoreLastChoices() }
        }
    }

    private var selectedProfile: ProfileInfo? {
        profiles.first { $0.name == profile }
    }

    /// Permission-mode choices. Append the current value so it doesn't vanish even when absent from the candidates
    private var permissionModeChoices: [PermissionModeChoice] {
        var out = selectedProfile?.permissionModeChoices
            ?? PermissionMode.known.map { PermissionModeChoice(id: $0.rawValue, label: $0.label) }
        if !out.contains(where: { $0.id == mode.rawValue }) {
            out.append(PermissionModeChoice(id: mode.rawValue, label: mode.label))
        }
        return out
    }

    /// Model / effort / permission mode default to the previous creation's choices (only when the selected profile offers them)
    private func restoreLastChoices() {
        let modeIds = permissionModeChoices.map(\.id)
        if let saved = UserDefaults.standard.string(forKey: "lastPermissionMode"), modeIds.contains(saved) {
            mode = PermissionMode(rawValue: saved)
        } else if !modeIds.contains(mode.rawValue) {
            mode = PermissionMode(rawValue: modeIds.first ?? PermissionMode.default.rawValue)
        }
        let models = selectedProfile?.modelChoices.map(\.id) ?? []
        if let m = UserDefaults.standard.string(forKey: "lastModelChoice"), m.isEmpty || models.contains(m) {
            modelChoice = m
        } else {
            modelChoice = ""
        }
        let efforts = selectedProfile?.effortChoices ?? []
        if let e = UserDefaults.standard.string(forKey: "lastEffortChoice"), e.isEmpty || efforts.contains(e) {
            effortChoice = e
        } else {
            effortChoice = ""
        }
    }

    /// Phone input easily picks up stray leading/trailing whitespace (predictive text, dictation), so always trim
    private var trimmedCwd: String {
        cwd.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func create() async {
        guard let backend = model.backend else { return }
        busy = true; defer { busy = false }
        do {
            let s = try await backend.createSession(
                profile: profile, cwd: trimmedCwd, permissionMode: mode,
                model: modelChoice.isEmpty ? nil : modelChoice,
                effort: effortChoice.isEmpty ? nil : effortChoice)
            UserDefaults.standard.set(mode.rawValue, forKey: "lastPermissionMode")
            UserDefaults.standard.set(modelChoice, forKey: "lastModelChoice")
            UserDefaults.standard.set(effortChoice, forKey: "lastEffortChoice")
            dismiss()
            onCreated(s)
        } catch {
            // Missing cwd is 404 {"error":"cwd not found: ..."}; missing profile is 500
            self.error = error.localizedDescription
        }
    }
}
