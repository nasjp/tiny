import XCTest
@testable import Tiny

final class ThemeTests: XCTestCase {
    /// Guarantees the asset catalog has a color set for every token.
    /// Typos in names and forgotten color sets are not caught by the build.
    func testAllColorTokensResolve() {
        let tokens = ["bg", "card", "ink", "inkSub", "tint", "ruby", "line", "stRunning", "stDetached"]
        for name in tokens {
            XCTAssertNotNil(
                UIColor(named: name, in: Bundle(for: AppModel.self), compatibleWith: nil),
                "color set '\(name)' is missing from the asset catalog")
        }
    }

    /// Whether Inter is registered. On failure, use the printed candidate list to
    /// align Theme.swift's interFamily constant with the measured name (per the plan).
    func testInterFontRegistered() {
        let families = UIFont.familyNames.filter { $0.localizedCaseInsensitiveContains("inter") }
        print("Inter families:", families,
              "fonts:", families.flatMap { UIFont.fontNames(forFamilyName: $0) })
        XCTAssertFalse(families.isEmpty, "Inter is not registered as a font (check UIAppFonts / bundled resources)")
    }

    /// Whether Noto Sans JP (bundled, variable subset with wght 400–700) is registered
    func testNotoFontRegistered() {
        let names = UIFont.fontNames(forFamilyName: "Noto Sans JP")
        XCTAssertTrue(names.contains("NotoSansJP-Regular"), "Noto not registered: \(names)")
    }

    /// Measured mixed-cascade resolution: Latin resolves to Inter, Japanese to Noto,
    /// and bold to a real variable-axis Bold. CJK fixtures are written as escapes
    /// (U+9032 U+6357 "progress", U+592A U+5B57 "bold") to keep the source English-only
    func testTinyMixedCascadeResolution() {
        func resolved(_ s: String, weight: UIFont.Weight = .regular) -> [(family: String, weight: Double)] {
            let a = NSAttributedString(string: s, attributes: [.font: UIFont.tinyMixed(size: 17, weight: weight)])
            let runs = CTLineGetGlyphRuns(CTLineCreateWithAttributedString(a)) as! [CTRun]
            return runs.map {
                let f = (CTRunGetAttributes($0) as! [NSAttributedString.Key: Any])[.font] as! UIFont
                let traits = f.fontDescriptor.object(forKey: .traits) as? [String: Any] ?? [:]
                return (f.familyName, (traits["NSCTFontWeightTrait"] as? Double) ?? 0)
            }
        }
        XCTAssertTrue(resolved("Running").allSatisfy { $0.family.contains("Inter") })
        XCTAssertTrue(resolved("\u{9032}\u{6357}").allSatisfy { $0.family.contains("Noto") },
                      "Japanese fell through to Hiragino: \(resolved("\u{9032}\u{6357}"))")
        // Bold must be a real Bold for Japanese too (weight trait ≈ 0.4; catches synthetic bold and Regular leftovers)
        let bold = resolved("\u{592A}\u{5B57}", weight: .bold)
        XCTAssertTrue(bold.allSatisfy { $0.family.contains("Noto") && $0.weight > 0.3 },
                      "bold resolved to: \(bold)")
    }

    /// Pins Appearance's storage-key compatibility (rawValue) and colorScheme mapping
    func testAppearanceMapping() {
        XCTAssertEqual(Appearance.system.rawValue, "system")
        XCTAssertEqual(Appearance.light.rawValue, "light")
        XCTAssertEqual(Appearance.dark.rawValue, "dark")
        XCTAssertNil(Appearance.system.colorScheme)
        XCTAssertEqual(Appearance.light.colorScheme, .light)
        XCTAssertEqual(Appearance.dark.colorScheme, .dark)
        XCTAssertEqual(Appearance.allCases.count, 3)
    }
}
