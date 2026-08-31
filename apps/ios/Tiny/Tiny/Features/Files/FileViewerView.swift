import QuickLook
import SwiftUI
import WebKit

/// Display for send_user_file. HTML is fetched as data and shown via WKWebView's
/// loadHTMLString (self-contained HTML assumed; JS disabled, external navigation
/// refused, bearer never put in a URL); everything else (images, PDFs, etc.) is
/// dropped to a temp file and shown with QuickLook.
struct FileViewerView: View {
    let fileId: String
    let mime: String
    let name: String
    let chat: ChatModel
    @Environment(\.dismiss) private var dismiss
    @State private var localURL: URL?
    @State private var htmlData: Data?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let error {
                    ContentUnavailableView("Failed to load", systemImage: "doc.questionmark",
                                           description: Text(error))
                } else if mime == "text/html" {
                    // Never put the bearer in a URL: fetch as data and display via loadHTMLString
                    if let data = htmlData {
                        WebView(html: String(decoding: data, as: UTF8.self))
                    } else {
                        ProgressView().task { await loadData() }
                    }
                } else if let localURL {
                    QuickLookView(url: localURL)
                } else {
                    ProgressView().task { await loadToTemp() }
                }
            }
            .background(Color.tBg)
            .navigationTitle(name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func loadData() async {
        do { htmlData = try await chat.fileData(fileId: fileId).data }
        catch { self.error = error.localizedDescription }
    }

    private func loadToTemp() async {
        do {
            let (data, _) = try await chat.fileData(fileId: fileId)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent(fileId)
                .appendingPathExtension((name as NSString).pathExtension.isEmpty
                                        ? "dat" : (name as NSString).pathExtension)
            try data.write(to: url)
            localURL = url
        } catch { self.error = error.localizedDescription }
    }
}

/// The initial loadHTMLString(baseURL: nil) load arrives as about:blank / .other.
/// Allow only that; refuse all external navigation (link taps, meta refresh, etc.).
enum WebViewNavigationPolicy {
    static func allows(url: URL?, type: WKNavigationType) -> Bool {
        guard type == .other else { return false }
        guard let url else { return true }
        return url.absoluteString == "about:blank"
    }
}

struct WebView: UIViewRepresentable {
    let html: String

    /// JS disabled (a malicious script slipped into generated HTML must never run)
    static func makeHardenedConfiguration() -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        return config
    }

    static func makeHardened(coordinator: Coordinator) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: makeHardenedConfiguration())
        webView.navigationDelegate = coordinator
        return webView
    }

    func makeUIView(context: Context) -> WKWebView {
        Self.makeHardened(coordinator: context.coordinator)
    }
    func updateUIView(_ webView: WKWebView, context: Context) {
        // updateUIView is called on every parent-view update. Loading every time
        // turns each incoming WS event into a reload→update→reload loop.
        // Load the same content only once.
        guard !context.coordinator.loadedHTML else { return }
        context.coordinator.loadedHTML = true
        webView.loadHTMLString(html, baseURL: nil)
    }
    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedHTML = false

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let allowed = WebViewNavigationPolicy.allows(
                url: navigationAction.request.url,
                type: navigationAction.navigationType)
            decisionHandler(allowed ? .allow : .cancel)
        }
    }
}

struct QuickLookView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> QLPreviewController {
        let vc = QLPreviewController()
        vc.dataSource = context.coordinator
        return vc
    }
    func updateUIViewController(_ vc: QLPreviewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController,
                               previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}
