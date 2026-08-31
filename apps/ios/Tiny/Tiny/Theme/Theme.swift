import SwiftUI

/// Token layer for the visual palette (source of truth: docs/superpowers/specs/2026-08-27-ui-tonmana-design.md).
/// Views must reference colors through this extension only — never raw hex or Color("name").
extension Color {
    static let tBg = Color("bg")
    static let tCard = Color("card")
    static let tInk = Color("ink")
    static let tInkSub = Color("inkSub")
    static let tTint = Color("tint")
    static let tRuby = Color("ruby")
    static let tLine = Color("line")
    static let tRunning = Color("stRunning")
    static let tDetached = Color("stDetached")
}

/// UI typography = Inter (Latin) + Noto Sans JP (Japanese, bundled subset) mixed.
/// Leaving Japanese to Hiragino makes the alphanumerics (Inter) and Japanese differ
/// in weight and look patchwork, so resolve via cascadeList in the order
/// Inter → Noto → system (Hiragino catches the rest).
/// Noto is subset to roughly JIS X 0208 (rare kanji fall through to Hiragino, so nothing is missing).
/// Meta info (cwd, timestamps, tool rows) uses .fontDesign(.monospaced), not this Font.
extension UIFont {
    static func tinyMixed(size: CGFloat, weight: UIFont.Weight = .regular) -> UIFont {
        // Noto is a variable font restricted to wght 400–700. Pinning it by PS name
        // makes SwiftUI embolden only Inter in bold spans, leaving Japanese stuck at
        // Regular (found on device) — so specify by family and let the variable axis
        // track the weight
        let desc = UIFontDescriptor(fontAttributes: [
            .family: "Inter",   // matches the measured name in ThemeTests
            .traits: [UIFontDescriptor.TraitKey.weight: weight],
            .cascadeList: [UIFontDescriptor(fontAttributes: [
                .family: "Noto Sans JP",
                .traits: [UIFontDescriptor.TraitKey.weight: weight],
            ])],
        ])
        return UIFont(descriptor: desc, size: size)
    }
}

extension Font {
    /// Tracks Dynamic Type: UIFontMetrics scales by the text-size setting at call time.
    /// On a size change SwiftUI re-evaluates the views and re-runs this function, so it
    /// follows along (which is why the tiny* helpers are computed vars, not static-let caches)
    static func tiny(_ size: CGFloat, weight: Font.Weight = .regular,
                     relativeTo style: Font.TextStyle = .body) -> Font {
        let base = UIFont.tinyMixed(size: size, weight: weight.uiWeight)
        return Font(UIFontMetrics(forTextStyle: style.uiTextStyle).scaledFont(for: base))
    }

    // Quick reference mapped to the system text styles' default sizes (Dynamic Type aware)
    static var tinyTitle: Font { .tiny(28, weight: .bold, relativeTo: .title) }
    static var tinyHeadline: Font { .tiny(17, weight: .semibold, relativeTo: .headline) }
    static var tinyBody: Font { .tiny(17, relativeTo: .body) }
    static var tinyCallout: Font { .tiny(16, relativeTo: .callout) }
    static var tinySubheadline: Font { .tiny(15, relativeTo: .subheadline) }
    static var tinyFootnote: Font { .tiny(13, relativeTo: .footnote) }
    static var tinyCaption: Font { .tiny(12, relativeTo: .caption) }
    static var tinyCaption2: Font { .tiny(11, relativeTo: .caption2) }
}

extension Font.Weight {
    var uiWeight: UIFont.Weight {
        switch self {
        case .ultraLight: .ultraLight
        case .thin: .thin
        case .light: .light
        case .regular: .regular
        case .medium: .medium
        case .semibold: .semibold
        case .bold: .bold
        case .heavy: .heavy
        case .black: .black
        default: .regular
        }
    }
}

extension Font.TextStyle {
    var uiTextStyle: UIFont.TextStyle {
        switch self {
        case .largeTitle: .largeTitle
        case .title: .title1
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .subheadline: .subheadline
        case .body: .body
        case .callout: .callout
        case .footnote: .footnote
        case .caption: .caption1
        case .caption2: .caption2
        default: .body
        }
    }
}

/// Appearance override (toggled in Settings, rawValue stored in AppStorage)
enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    /// Display label in Settings (user-facing copy is English — repo policy)
    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
    /// Value passed to preferredColorScheme. system is nil = follow the OS
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

// MARK: - Motion

/// Appear effect for chat rows. Instead of "popping in", rows well up.
/// The curve follows the SwipeActionCard lesson (a spring with gooey deceleration
/// feels slow and cheap): no bounce, on the fast side. Under Reduce Motion the
/// caller drops it to opacity only.
extension Animation {
    static let tinyAppear = Animation.spring(response: 0.3, dampingFraction: 0.9)
    /// Reduce Motion alternative (no movement or blur; just appears quickly)
    static let tinyAppearReduced = Animation.easeOut(duration: 0.15)
}

extension AnyTransition {
    /// Rises 10pt from below while coming into focus from a blur.
    /// Removal gets no effect (spending time on disappearing things makes interactions feel heavy).
    /// blurReplace(.downUp) is exactly the "rise from below, blurred, then focus" insertion motion.
    /// AnyTransition has no static member for it, so wrap the concrete Transition type explicitly
    static var tinyAppear: AnyTransition {
        .asymmetric(
            insertion: AnyTransition(BlurReplaceTransition(configuration: .downUp))
                .combined(with: .opacity)
                .combined(with: .offset(y: 8)),
            removal: .opacity)
    }

    /// Reduce Motion alternative
    static var tinyAppearReduced: AnyTransition {
        .asymmetric(insertion: .opacity, removal: .opacity)
    }
}
