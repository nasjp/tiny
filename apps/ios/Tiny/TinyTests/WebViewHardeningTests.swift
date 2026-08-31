import WebKit
import XCTest

@testable import Tiny

/// Regression net for WebView hardening (leftover task from the 2026-08-28 security audit).
/// - JS disabled: a malicious script slipped into generated HTML must never run
/// - Navigation restricted: everything but loadHTMLString's initial load (link taps, external navigation) is refused
final class WebViewHardeningTests: XCTestCase {

    @MainActor
    func testHardenedConfigurationDisablesJavaScript() {
        let config = WebView.makeHardenedConfiguration()
        XCTAssertFalse(config.defaultWebpagePreferences.allowsContentJavaScript)
    }

    func testPolicyAllowsInitialAboutBlankLoad() {
        // loadHTMLString(baseURL: nil)'s main-frame load is about:blank / .other
        XCTAssertTrue(WebViewNavigationPolicy.allows(url: URL(string: "about:blank"), type: .other))
        XCTAssertTrue(WebViewNavigationPolicy.allows(url: nil, type: .other))
    }

    func testPolicyRejectsLinkActivation() {
        XCTAssertFalse(WebViewNavigationPolicy.allows(
            url: URL(string: "https://example.com"), type: .linkActivated))
        XCTAssertFalse(WebViewNavigationPolicy.allows(
            url: URL(string: "about:blank"), type: .linkActivated))
    }

    func testPolicyRejectsExternalNavigation() {
        // Even .other loads (meta refresh etc.) are refused when the destination is not about:blank
        XCTAssertFalse(WebViewNavigationPolicy.allows(
            url: URL(string: "https://evil.example/"), type: .other))
        XCTAssertFalse(WebViewNavigationPolicy.allows(
            url: URL(string: "http://mac:7777/v1/files/f1?token=tok"), type: .other))
        XCTAssertFalse(WebViewNavigationPolicy.allows(
            url: URL(string: "https://example.com/form"), type: .formSubmitted))
    }

    @MainActor
    func testWebViewInstallsNavigationDelegate() {
        // If makeUIView forgets to install the delegate, the policy has no effect at all
        let view = WebView(html: "<html></html>")
        let context = view.makeCoordinator()
        let webView = WebView.makeHardened(coordinator: context)
        XCTAssertTrue(webView.navigationDelegate === context)
        XCTAssertFalse(webView.configuration.defaultWebpagePreferences.allowsContentJavaScript)
    }
}
