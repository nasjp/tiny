import XCTest
@testable import Tiny

/// Regression net for the in-app legal pathways (Phase F).
/// Protects the material backing "Privacy is reachable from the unpaired screen"
/// checked in review (Guideline 5.1.1) — external URLs, bundled license texts,
/// Info.plist strings — from going missing
final class AboutTests: XCTestCase {

    // MARK: - External links

    func testExternalLinksAreExactAndHTTPS() {
        // Source of truth for the values is HANDOFF "next steps §4". Update HANDOFF when changing these
        XCTAssertEqual(ExternalLink.privacy.absoluteString,
                       "https://tanirell.com/legal/tiny/privacy-policy")
        XCTAssertEqual(ExternalLink.terms.absoluteString,
                       "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")
        XCTAssertEqual(ExternalLink.setup.absoluteString,
                       "https://github.com/nasjp/tiny#readme")
        XCTAssertEqual(ExternalLink.support.absoluteString,
                       "https://github.com/nasjp/tiny/issues")

        for url in ExternalLink.all {
            XCTAssertEqual(url.scheme, "https", "\(url) is not https")
            XCTAssertNotNil(url.host, "\(url) has no host")
        }
    }

    func testPrivacyURLHasNoFileExtension() {
        // tanirell.com 308-redirects extensioned URLs (.html) to the extensionless form.
        // Point directly at the canonical form (so the URL referenced in review has no redirect)
        XCTAssertFalse(ExternalLink.privacy.absoluteString.hasSuffix(".html"))
    }

    // MARK: - OFL for the bundled fonts (bundling the license is an OFL requirement)

    func testBundledFontLicensesArePresentAndComplete() {
        XCTAssertEqual(BundledFontLicense.all.map(\.name), ["Inter", "Noto Sans JP"])

        for license in BundledFontLicense.all {
            let text = license.text
            XCTAssertFalse(text.isEmpty,
                           "\(license.name) license text is unreadable (possibly not in the target)")
            XCTAssertTrue(text.contains("SIL OPEN FONT LICENSE Version 1.1"),
                          "\(license.name) is missing the OFL 1.1 body")
            XCTAssertTrue(text.contains("PERMISSION & CONDITIONS"),
                          "\(license.name) OFL body is cut off midway")
        }
    }

    func testEachFontLicenseCarriesItsOwnCopyright() {
        // The body (OFL 1.1) is shared, so a mix-up is only detectable via the copyright line
        let byName = Dictionary(uniqueKeysWithValues: BundledFontLicense.all.map { ($0.name, $0.text) })
        XCTAssertTrue(byName["Inter"]?.contains("The Inter Project Authors") == true)
        XCTAssertTrue(byName["Noto Sans JP"]?.contains("Adobe") == true)
    }

    // MARK: - Info.plist

    func testInfoPlistHasLocalNetworkUsageDescription() {
        // QR destination validation allows 192.168/16, 10/8, 172.16/12, and .local,
        // so LAN users get the local-network permission prompt. Without our copy it falls back to the default text
        let value = Bundle.main.object(forInfoDictionaryKey: "NSLocalNetworkUsageDescription") as? String
        XCTAssertNotNil(value, "NSLocalNetworkUsageDescription is missing from Info.plist")
        XCTAssertFalse((value ?? "").isEmpty)
    }

    // MARK: - Version display

    func testVersionTextFormatsShortVersionAndBuild() {
        XCTAssertEqual(AboutView.versionText(shortVersion: "1.0", build: "26"), "1.0 (26)")
        XCTAssertEqual(AboutView.versionText(shortVersion: "1.0", build: nil), "1.0")
        XCTAssertEqual(AboutView.versionText(shortVersion: nil, build: "26"), "-")
        XCTAssertEqual(AboutView.versionText(shortVersion: nil, build: nil), "-")
    }

    func testVersionTextFromBundleIsPopulated() {
        // Must actually be populated from GENERATE_INFOPLIST_FILE + project.yml build settings
        XCTAssertNotEqual(AboutView.bundleVersionText, "-")
    }

    // MARK: - Trademark notice (Anthropic brand guidelines)

    func testTrademarkNoticeDisclaimsAffiliation() {
        let notice = AboutView.trademarkNotice
        XCTAssertTrue(notice.contains("Anthropic"))
        XCTAssertTrue(notice.contains("not affiliated"))
        // Never claim "Claude Code" as a product name (the form the guidelines disallow)
        XCTAssertFalse(notice.contains("Claude Code Agent"))
    }

    // MARK: - Connection error copy

    func testConnectionErrorHintMentionsBothLANAndTailscale() {
        // The old copy pointed only at Tailscale and missed LAN users
        let hint = AppModel.connectionErrorHint
        XCTAssertTrue(hint.contains("LAN"))
        XCTAssertTrue(hint.contains("Tailscale"))
    }
}
