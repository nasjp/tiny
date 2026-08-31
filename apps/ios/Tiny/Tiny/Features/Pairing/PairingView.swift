import SwiftUI

struct PairingView: View {
    @EnvironmentObject var model: AppModel
    @State private var manualURL = ""
    @State private var manualCode = ""
    @State private var busy = false
    @State private var showAbout = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    Text("Run `tiny pair` on your Mac and scan the QR code it shows.")
                        .font(.tinyCallout).foregroundStyle(Color.tInkSub)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    QRScannerView { raw in
                        guard !busy else { return }
                        guard let qr = PairQR.parse(raw) else {
                            model.pairingError = "This QR code isn't a pairing code. Run tiny pair on your Mac and scan the QR code it shows."
                            return
                        }
                        busy = true
                        Task { await model.pair(qr: qr, deviceName: deviceName); busy = false }
                    }
                    .frame(height: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 16))

                    DisclosureGroup("Enter manually (QR code won't scan)") {
                        VStack(spacing: 12) {
                            TextField("URL (e.g. http://mac:7777)", text: $manualURL)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .textFieldStyle(.roundedBorder)
                                .accessibilityIdentifier("pairURLField")
                            TextField("Code (8 characters)", text: $manualCode)
                                .textInputAutocapitalization(.characters).autocorrectionDisabled()
                                .textFieldStyle(.roundedBorder)
                                .accessibilityIdentifier("pairCodeField")
                            Button("Pair") {
                                guard !busy else { return }
                                busy = true
                                Task {
                                    await model.pair(qr: PairQR(url: manualURL,
                                                                code: Self.normalizeCode(manualCode)),
                                                     deviceName: deviceName)
                                    busy = false
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(manualURL.isEmpty || manualCode.count != 8 || busy)
                        }.padding(.top, 8)
                    }

                    if let err = model.pairingError {
                        Text(err).font(.tinyFootnote).foregroundStyle(Color.tRuby)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button("Try demo mode") { model.enterDemo() }
                        .font(.tinyFootnote)
                        .accessibilityIdentifier("demoModeButton")

                    footer
                }
                .padding()
            }
            .background(Color.tBg)
            .navigationTitle("Pairing")
            .sheet(isPresented: $showAbout) { AboutSheet() }
        }
    }

    /// The unpaired screen is the only screen a first-time user sees. If tinyd setup
    /// instructions and the legal pages aren't reachable from here, review (Guideline 5.1.1) bounces it
    private var footer: some View {
        VStack(spacing: 10) {
            Divider().padding(.top, 8)
            HStack(spacing: 4) {
                Text("Don't have tinyd yet?").foregroundStyle(Color.tInkSub)
                Link("Set up on your Mac", destination: ExternalLink.setup)
            }
            .font(.tinyFootnote)
            HStack(spacing: 6) {
                Link("Privacy", destination: ExternalLink.privacy)
                Text("·").foregroundStyle(Color.tInkSub)
                Link("Terms", destination: ExternalLink.terms)
                Text("·").foregroundStyle(Color.tInkSub)
                Button("About") { showAbout = true }
                    .accessibilityIdentifier("aboutButton")
            }
            .font(.tinyCaption)
        }
    }

    /// The code alphabet excludes I/O/0/1. Correct common misreads and uppercase
    static func normalizeCode(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            .replacingOccurrences(of: "0", with: "O")
            .replacingOccurrences(of: "1", with: "I")
    }

    private var deviceName: String { UIDevice.current.name }
}
