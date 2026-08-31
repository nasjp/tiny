import SwiftUI

/// Source of truth for external URLs opened from the app. Values come from HANDOFF "next steps §4".
/// Privacy / Terms are referenced during review (Guideline 5.1.1), so they point
/// somewhere independent of the repo's visibility (tanirell.com)
enum ExternalLink {
    /// tanirell.com 308-redirects extensioned URLs, so point directly at the canonical (extensionless) form
    static let privacy = URL(string: "https://tanirell.com/legal/tiny/privacy-policy")!
    /// Apple's standard EULA. Sufficient when not writing custom terms
    static let terms = URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!
    static let setup = URL(string: "https://github.com/nasjp/tiny#readme")!
    static let support = URL(string: "https://github.com/nasjp/tiny/issues")!

    static let all: [URL] = [privacy, terms, setup, support]
}

/// License texts for the bundled fonts. OFL requires bundling the license text,
/// so read and display the bundled txt as-is (never summarized)
struct BundledFontLicense: Identifiable {
    let name: String
    /// Name of the txt placed in Resources/Fonts (no extension)
    let resource: String

    var id: String { name }

    /// Empty string when unreadable. Tests catch a missing target membership here
    var text: String {
        guard let url = Bundle.main.url(forResource: resource, withExtension: "txt"),
              let s = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return s
    }

    static let all = [
        BundledFontLicense(name: "Inter", resource: "OFL-Inter"),
        BundledFontLicense(name: "Noto Sans JP", resource: "OFL-NotoSansJP"),
    ]
}

/// About sheet. Opened via push from Settings, and via AboutSheet from Pairing.
/// Holds no NavigationStack of its own (the caller decides push vs sheet)
struct AboutView: View {
    var body: some View {
        Form {
            Section {
                LabeledContent("Version", value: Self.bundleVersionText)
                    .fontDesign(.monospaced)
            } header: {
                Text("tiny")
            } footer: {
                Text("Run a coding agent on your Mac from your iPhone, then hand the session back to the CLI.")
            }
            .listRowBackground(Color.tCard)

            Section("Get started") {
                Link("Set up on your Mac", destination: ExternalLink.setup)
                Link("Support", destination: ExternalLink.support)
            }
            .listRowBackground(Color.tCard)

            Section {
                Link("Privacy Policy", destination: ExternalLink.privacy)
                Link("Terms of Use", destination: ExternalLink.terms)
                NavigationLink("Open-source licenses") { LicensesView() }
            } header: {
                Text("Legal")
            } footer: {
                Text(Self.trademarkNotice)
            }
            .listRowBackground(Color.tCard)
        }
        .scrollContentBackground(.hidden)
        .background(Color.tBg)
        .navigationTitle("About")
    }

    /// Trademark notice. tiny drives Claude / OpenCode / Codex / Cursor, so it names
    /// only Anthropic while still covering the other companies.
    /// Never claims "Claude Code" as a product name (the form Anthropic's brand guidelines disallow)
    static let trademarkNotice = """
        Claude is a trademark of Anthropic, PBC. Other product names are trademarks of their \
        respective owners. tiny is not affiliated with or endorsed by any of them — you run each \
        agent with your own account, on your own Mac.
        """

    /// "1.0 (26)". With no short version there is nothing to show, hence "-"
    static func versionText(shortVersion: String?, build: String?) -> String {
        guard let shortVersion, !shortVersion.isEmpty else { return "-" }
        guard let build, !build.isEmpty else { return shortVersion }
        return "\(shortVersion) (\(build))"
    }

    static var bundleVersionText: String {
        versionText(shortVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
                    build: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String)
    }
}

/// Full OFL text of the bundled fonts. Shown as-is, never summarized
struct LicensesView: View {
    var body: some View {
        List(BundledFontLicense.all) { license in
            NavigationLink(license.name) {
                ScrollView {
                    Text(license.text)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                }
                .background(Color.tBg)
                .navigationTitle(license.name)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.tBg)
        .navigationTitle("Open-source licenses")
    }
}

/// Wrapper for opening from the unpaired (Pairing) screen. Settings pushes onto its own NavigationStack instead
struct AboutSheet: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage("appearance") private var appearanceRaw = Appearance.system.rawValue

    var body: some View {
        NavigationStack {
            AboutView()
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
        }
        // Sheets do not inherit the presenter's .preferredColorScheme (same situation as SettingsView)
        .preferredColorScheme(Appearance(rawValue: appearanceRaw)?.colorScheme)
    }
}
