import XCTest
@testable import Tiny

final class MarkdownTextTests: XCTestCase {
    func testCJKBoldWithPunctuationParses() {
        // Regression net for a device bug where CommonMark's right-flanking rule refuses
        // emphasis for "full-width close paren + ** + hiragana" and the ** comes out raw.
        // Fixture (written as escapes to keep the source English-only) reads:
        // "**Taika-no-Kaishin (645)** was a political reform." in Japanese.
        let a = MarkdownText.inline(
            "**\u{5927}\u{5316}\u{306E}\u{6539}\u{65B0}\u{FF08}645\u{5E74}\u{FF09}**\u{306F}\u{3001}\u{653F}\u{6CBB}\u{6539}\u{9769}\u{3067}\u{3059}\u{3002}")
        let plain = String(a.characters)
        XCTAssertFalse(plain.contains("*"))
        XCTAssertTrue(plain.hasPrefix(
            "\u{5927}\u{5316}\u{306E}\u{6539}\u{65B0}\u{FF08}645\u{5E74}\u{FF09}\u{306F}"))
        XCTAssertTrue(a.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
    }

    func testBoldSpanCarriesExplicitMixedFont() {
        // SwiftUI's bold conversion does not propagate to the Japanese side of the
        // mixed-font cascade, so bold spans must carry an explicit font
        // (without it, only the Japanese half of bold text stays thin)
        let a = MarkdownText.inline("**bold96** and prose")
        XCTAssertTrue(a.runs.contains {
            $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true && $0.font != nil
        })
    }

    func testPlainBoldAndItalicStillWork() {
        let a = MarkdownText.inline("**bold** and *italic* and `code`")
        XCTAssertFalse(String(a.characters).contains("*"))
        XCTAssertTrue(a.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        XCTAssertTrue(a.runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true })
    }

    func testLoneDoubleAsteriskStaysLiteral() {
        // Unpaired ** or ** touching whitespace is not emphasis (math like 2 ** 3)
        XCTAssertTrue(String(MarkdownText.inline("2 ** 3 = 8").characters).contains("**"))
        XCTAssertTrue(String(MarkdownText.inline("a ** b ** c").characters).contains("**"))
    }

    func testMultipleBoldSpans() {
        // CJK fixture (escapes): "**first**and**second(2)**desu" with full-width parens,
        // exercising the right-flanking case across multiple bold spans
        let a = MarkdownText.inline(
            "**\u{4E00}\u{3064}\u{76EE}**\u{3068}**\u{4E8C}\u{3064}\u{76EE}\u{FF08}2\u{FF09}**\u{3067}\u{3059}")
        XCTAssertEqual(String(a.characters),
                       "\u{4E00}\u{3064}\u{76EE}\u{3068}\u{4E8C}\u{3064}\u{76EE}\u{FF08}2\u{FF09}\u{3067}\u{3059}")
    }

    // MARK: - Newline spacing (regression net for a device report where explicit newlines got the same spacing as wraps and paragraphs were unreadable)

    func testProseBlocksSplitsOnNewlines() {
        // Single newlines are normal lines; a blank line sets paragraphBreak on the next line
        XCTAssertEqual(MarkdownText.proseBlocks("line one\nline two\n\nline three"), [
            .init(text: "line one", paragraphBreak: false),
            .init(text: "line two", paragraphBreak: false),
            .init(text: "line three", paragraphBreak: true),
        ])
        // Leading indentation (nested lists) is preserved. Consecutive blank lines are one paragraph break
        XCTAssertEqual(MarkdownText.proseBlocks("- parent\n\n\n  - child"), [
            .init(text: "- parent", paragraphBreak: false),
            .init(text: "  - child", paragraphBreak: true),
        ])
        XCTAssertEqual(MarkdownText.proseBlocks("single line"),
                       [.init(text: "single line", paragraphBreak: false)])
    }

    func testListItemParsing() {
        // Decomposition for hanging indent
        let a = MarkdownText.listItem("- all six exercises done")
        XCTAssertEqual(a?.indent, 0); XCTAssertEqual(a?.marker, "-"); XCTAssertEqual(a?.body, "all six exercises done")
        let b = MarkdownText.listItem("  - child item")
        XCTAssertEqual(b?.indent, 2); XCTAssertEqual(b?.marker, "-")
        let c = MarkdownText.listItem("1. numbered")
        XCTAssertEqual(c?.marker, "1."); XCTAssertEqual(c?.body, "numbered")
        // No false positives: bold, math, marker-only lines, ordinary sentences
        XCTAssertNil(MarkdownText.listItem("**bold** text"))
        XCTAssertNil(MarkdownText.listItem("2 ** 3 = 8"))
        XCTAssertNil(MarkdownText.listItem("- "))
        XCTAssertNil(MarkdownText.listItem("an ordinary sentence"))
    }

    // MARK: - Headings (regression net for a device report where ### came out raw)

    func testHeadingParsing() {
        let h = MarkdownText.heading("### Option 1: Kanda Yabu Soba (2-min walk)")
        XCTAssertEqual(h?.level, 3); XCTAssertEqual(h?.body, "Option 1: Kanda Yabu Soba (2-min walk)")
        XCTAssertEqual(MarkdownText.heading("# Big heading")?.level, 1)
        XCTAssertEqual(MarkdownText.heading("###### level six")?.level, 6)
        // Closing #s and up to 3 leading spaces are allowed, per CommonMark
        XCTAssertEqual(MarkdownText.heading("## Heading ##")?.body, "Heading")
        XCTAssertEqual(MarkdownText.heading("  ## indented")?.level, 2)
        // No false positives: hashtags, 7 levels, empty headings, mid-sentence #
        XCTAssertNil(MarkdownText.heading("#hashtag"))
        XCTAssertNil(MarkdownText.heading("####### level seven"))
        XCTAssertNil(MarkdownText.heading("#"))
        XCTAssertNil(MarkdownText.heading("### "))
        XCTAssertNil(MarkdownText.heading("ordinary # sentence"))
    }

    func testHeadingTextDropsMarkerAndCarriesFont() {
        // Headings drop the markers and the whole run gets the heading font
        // (must not lose to the inner **'s explicit 17pt)
        let a = MarkdownText.headingText(level: 3, "Option 1 **bold**")
        XCTAssertEqual(String(a.characters), "Option 1 bold")
        XCTAssertFalse(a.runs.contains { $0.font == nil })
        XCTAssertTrue(a.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
    }

    func testThematicBreakParsing() {
        // Device report of --- coming out raw. Per CommonMark: 3+ of - * _ (spaces in between allowed)
        XCTAssertTrue(MarkdownText.isThematicBreak("---"))
        XCTAssertTrue(MarkdownText.isThematicBreak("-----"))
        XCTAssertTrue(MarkdownText.isThematicBreak("***"))
        XCTAssertTrue(MarkdownText.isThematicBreak("___"))
        XCTAssertTrue(MarkdownText.isThematicBreak("- - -"))
        XCTAssertTrue(MarkdownText.isThematicBreak("  ---  "))
        // No false positives: two chars, mixed symbols, trailing text, list items
        XCTAssertFalse(MarkdownText.isThematicBreak("--"))
        XCTAssertFalse(MarkdownText.isThematicBreak("-*-"))
        XCTAssertFalse(MarkdownText.isThematicBreak("--- divider"))
        XCTAssertFalse(MarkdownText.isThematicBreak("- item"))
    }

    func testLinksAreUnderlined() {
        let a = MarkdownText.inline("[docs](https://example.com) and https://example.org/x")
        let linkRuns = a.runs.filter { $0.link != nil }
        XCTAssertEqual(linkRuns.count, 2)
        XCTAssertTrue(linkRuns.allSatisfy { $0.underlineStyle == .single })
    }

    // MARK: - Regression net for a device bug where a bare-URL autolink swallowed the trailing close paren

    func testAutolinkDropsTrailingParen() {
        let a = MarkdownText.inline("(https://share-pages.com/74d7c538/) see this")
        let links = a.runs.compactMap(\.link)
        XCTAssertEqual(links.count, 1)
        XCTAssertEqual(links.first?.absoluteString, "https://share-pages.com/74d7c538/")
        // ")" stays outside the link (must not be deleted)
        XCTAssertTrue(String(a.characters).contains(") see this"))
    }

    func testAutolinkKeepsBalancedParen() {
        // Parens balanced inside the URL (Wikipedia style) are not trimmed.
        // The \u{3002} case checks that the CJK full stop is trimmed too
        XCTAssertEqual(MarkdownText.trailingLinkJunkCount("https://en.wikipedia.org/wiki/A_(band)"), 0)
        XCTAssertEqual(MarkdownText.trailingLinkJunkCount("https://example.com/a)"), 1)
        XCTAssertEqual(MarkdownText.trailingLinkJunkCount("https://example.com/a)\u{3002}"), 2)
        XCTAssertEqual(MarkdownText.trailingLinkJunkCount("https://example.com/a."), 1)
        XCTAssertEqual(MarkdownText.trailingLinkJunkCount("https://example.com/a"), 0)
    }

    func testExplicitMarkdownLinkUntouched() {
        // Explicit [label](URL) links follow the author's intent (trailing ) kept as part of the URL)
        let a = MarkdownText.inline("[docs](https://example.com/a_(1))")
        XCTAssertEqual(a.runs.compactMap(\.link).first?.absoluteString, "https://example.com/a_(1)")
    }

    // MARK: - Forcing emoji presentation (regression net for a device bug where ⬜ was drawn with Inter's huge glyph and broke the line)

    func testEmojiPresentationForcedForWhiteSquare() {
        // ⬜ (U+2B1C) has its own glyph in Inter, so append VS16 to pin emoji rendering
        let out = MarkdownText.forcingEmojiPresentation("⬜ task")
        XCTAssertTrue(out.unicodeScalars.contains("\u{FE0F}"))
        XCTAssertTrue(out.hasPrefix("⬜\u{FE0F}"))
        // Also applied when going through inline() (String.contains works on graphemes
        // and cannot detect a lone VS16, so check unicodeScalars)
        XCTAssertTrue(String(MarkdownText.inline("⬜ task").characters)
            .unicodeScalars.contains("\u{FE0F}"))
    }

    func testEmojiPresentationNoDoubleInsert() {
        XCTAssertEqual(MarkdownText.forcingEmojiPresentation("⬜\u{FE0F} x"), "⬜\u{FE0F} x")
    }

    func testEmojiPresentationLeavesPlainTextAlone() {
        let s = "Progress (0/6) ① seated leg press 190×10×3 **bold**"
        XCTAssertEqual(MarkdownText.forcingEmojiPresentation(s), s)
    }

    func testEmojiPresentationKeepsSkinToneSequences() {
        // Do not insert VS16 between ✋ (U+270B) and a skin-tone modifier; keep the sequence intact
        XCTAssertEqual(MarkdownText.forcingEmojiPresentation("✋🏻"), "✋🏻")
    }

    func testVS16ResolvesToAppleColorEmojiUnderInter() {
        // Measured CoreText behavior: even with Inter specified, VS16 makes Apple Color Emoji win
        guard let inter = UIFont(name: "Inter", size: 17) else {
            return XCTFail("Could not resolve Inter")
        }
        func resolvedFonts(_ s: String) -> [String] {
            let a = NSAttributedString(string: s, attributes: [.font: inter])
            let line = CTLineCreateWithAttributedString(a)
            let runs = CTLineGetGlyphRuns(line) as! [CTRun]
            return runs.map {
                let attrs = CTRunGetAttributes($0) as! [NSAttributedString.Key: Any]
                return (attrs[.font] as! UIFont).fontName
            }
        }
        // Bare ⬜ is drawn by Inter itself (= the bug's precondition; if Inter drops the glyph this net is moot)
        XCTAssertTrue(resolvedFonts("⬜").contains { $0.contains("Inter") })
        // With VS16 appended it switches to Apple Color Emoji (= the fix's effect)
        XCTAssertTrue(resolvedFonts("⬜\u{FE0F}").contains { $0.contains("AppleColorEmoji") })
    }

    // MARK: - Blockquotes

    func testStrippingQuoteMarker() {
        XCTAssertEqual(MarkdownText.strippingQuoteMarker("> hoge"), "hoge")
        // CommonMark does not require a space after `>`
        XCTAssertEqual(MarkdownText.strippingQuoteMarker(">hoge"), "hoge")
        // An empty quote line. Kept as a paragraph break inside the quote
        XCTAssertEqual(MarkdownText.strippingQuoteMarker(">"), "")
        // Only one level is stripped (the rest is consumed by the recursive inner pass)
        XCTAssertEqual(MarkdownText.strippingQuoteMarker(">> nest"), "> nest")
        XCTAssertEqual(MarkdownText.strippingQuoteMarker("   > indent"), "indent")
        // Only one space is consumed (to preserve nested-list indentation like `> - a` / `>   - b`)
        XCTAssertEqual(MarkdownText.strippingQuoteMarker(">   - child"), "  - child")

        // 4 leading spaces is indented code in CommonMark
        XCTAssertNil(MarkdownText.strippingQuoteMarker("    > code"))
        XCTAssertNil(MarkdownText.strippingQuoteMarker("2 > 1"))
        XCTAssertNil(MarkdownText.strippingQuoteMarker("-> arrow"))
        XCTAssertNil(MarkdownText.strippingQuoteMarker("ordinary sentence"))
        XCTAssertNil(MarkdownText.strippingQuoteMarker(""))
    }

    func testQuoteBlockGroupsConsecutiveLines() {
        // Group consecutive lines into one block so the vertical rule is not broken per line
        let b = MarkdownText.quoteBlock(["> hoge", "> huga", "> piyo", "", "after"], from: 0)
        XCTAssertEqual(b?.body, "hoge\nhuga\npiyo")
        XCTAssertEqual(b?.next, 3)
    }

    func testQuoteBlockStopsAtNonQuoteLine() {
        // No lazy continuation (keep the quote boundary explicit)
        let b = MarkdownText.quoteBlock(["> hoge", "prose", "> fuga"], from: 0)
        XCTAssertEqual(b?.body, "hoge")
        XCTAssertEqual(b?.next, 1)
    }

    func testQuoteBlockKeepsInnerBlankQuoteLine() {
        let b = MarkdownText.quoteBlock(["> a", ">", "> b"], from: 0)
        XCTAssertEqual(b?.body, "a\n\nb")
        XCTAssertEqual(b?.next, 3)
    }

    func testQuoteBlockKeepsNestedMarker() {
        XCTAssertEqual(MarkdownText.quoteBlock(["> outer", ">> inner"], from: 0)?.body,
                       "outer\n> inner")
    }

    func testQuoteBlockReturnsNilForNonQuote() {
        XCTAssertNil(MarkdownText.quoteBlock(["prose", "> a"], from: 0))
        XCTAssertNil(MarkdownText.quoteBlock([], from: 0))
    }

    func testSegmentsSplitsQuoteAsOwnBlock() {
        XCTAssertEqual(MarkdownText("before\n\n> hoge\n> huga\n\nafter").segments,
                       [.prose("before"), .quote("hoge\nhuga"), .prose("after")])
    }

    func testSegmentsKeepsQuoteMarkerInsideCodeFence() {
        // A `>` inside a code fence is not a quote (shell prompts and the like)
        XCTAssertEqual(MarkdownText("```\n> not a quote\n```").segments,
                       [.code("> not a quote")])
    }

    func testSegmentsStopsQuoteRecursionAtMaxDepth() {
        // The cap that keeps degenerate `>>>>>>…` input from indenting off the screen
        XCTAssertEqual(MarkdownText("> x", depth: MarkdownText.maxQuoteDepth).segments,
                       [.prose("> x")])
        XCTAssertEqual(MarkdownText("> x", depth: MarkdownText.maxQuoteDepth - 1).segments,
                       [.quote("x")])
    }
}
