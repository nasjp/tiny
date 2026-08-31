import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var confirmUnpair = false
    @AppStorage("appearance") private var appearanceRaw = Appearance.system.rawValue

    var body: some View {
        NavigationStack {
            Form {
                Section("Appearance") {
                    Picker("Appearance", selection: $appearanceRaw) {
                        ForEach(Appearance.allCases) { a in
                            Text(a.label).tag(a.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
                .listRowBackground(Color.tCard)
                Section("Connection") {
                    LabeledContent("Server", value: model.serverURL?.absoluteString ?? "(demo mode)")
                        .fontDesign(.monospaced)
                    LabeledContent("Device ID",
                                   value: SharedKeychain.get(.deviceId) ?? "-")
                        .fontDesign(.monospaced)
                }
                .listRowBackground(Color.tCard)
                Section {
                    // The legal pathway must also be reachable in demo mode (Settings
                    // opens both after pairing and in demo, so placing it here satisfies both)
                    NavigationLink("About") { AboutView() }
                }
                .listRowBackground(Color.tCard)
                Section {
                    Button("Unpair", role: .destructive) { confirmUnpair = true }
                        .tint(Color.tRuby)
                } footer: {
                    Text("Unpairing deletes this device's credentials and notification key. Reconnecting requires running `tiny pair` on your Mac.")
                }
                .listRowBackground(Color.tCard)
            }
            .scrollContentBackground(.hidden)
            .background(Color.tBg)
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Unpair this device?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) { model.unpair(); dismiss() }
            }
        }
        // SwiftUI sheets do not inherit the presenter's .preferredColorScheme,
        // so apply it explicitly at this sheet's root from the same AppStorage value
        .preferredColorScheme(Appearance(rawValue: appearanceRaw)?.colorScheme)
    }
}
