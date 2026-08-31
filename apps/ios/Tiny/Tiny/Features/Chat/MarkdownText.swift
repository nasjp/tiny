import SwiftUI

/// Lightweight Markdown display. Code fences (```) become monospaced blocks, tables
/// become a Grid, ATX headings (# through ######) get a bold heading font, quotes (>)
/// get a vertical rule on the left, and everything else is rendered per line as
/// AttributedString inline markdown (bold, italic, inline code, links).
/// Full list support is out of scope (keep lists readable as plain text without breaking them).
struct MarkdownText: View {
    let text: String
    /// Quote nesting depth. The body recurses into MarkdownText itself, so this caps
    /// degenerate input (`>>>>>>…`) from indenting off the screen
    let depth: Int

    /// Quotes deeper than this are not treated as quotes; they fall back to plain lines
    static let maxQuoteDepth = 5

    init(_ text: String, depth: Int = 0) {
        self.text = text
        self.depth = depth
    }

    var body: some View {
        // Anything narrower than paragraph spacing (14pt) inverts into "tight only around code blocks", so match it
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                switch seg {
                case .code(let code):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(code)
                            .font(.caption.monospaced())
                            .padding(10)
                    }
                    // SwiftUI's horizontal ScrollView can be dragged sideways and wobbles
                    // even when content fits (alwaysBounceHorizontal defaults to true; measured).
                    // Only allow movement when wider than the frame
                    .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
                    .background(Color.tCard)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                case .prose(let prose):
                    // Explicit newlines get more space than wrapped lines, and blank-line
                    // paragraphs even more (putting \n inside one Text gives uniform line
                    // spacing and the breaks become unreadable). Split into one Text per
                    // line: VStack (14pt) + 8pt extra at paragraph starts = 22pt
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(Array(Self.proseBlocks(prose).enumerated()), id: \.offset) { _, block in
                            Group {
                                if Self.isThematicBreak(block.text) {
                                    // --- rendered raw (device report). Draw as a horizontal rule
                                    Divider().padding(.vertical, 4)
                                } else if let h = Self.heading(block.text) {
                                    // ### rendered raw (device report). Drop the markers and draw with the heading font
                                    Text(Self.headingText(level: h.level, h.body))
                                } else if let item = Self.listItem(block.text) {
                                    // Hanging indent: wrapped lines align to the right of the marker
                                    // (as plain text the second line snaps back to the left edge and looks ragged)
                                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                                        Text(Self.inline(item.marker))
                                        Text(Self.inline(item.body))
                                    }
                                    .padding(.leading, CGFloat(item.indent) * 4)
                                } else {
                                    Text(Self.inline(block.text))
                                }
                            }
                            // Line height ~1.6em (on par with the official Claude app).
                            // Inter/Noto's natural line height (~20.6pt at 17pt) + 8pt
                            .lineSpacing(8)
                            .textSelection(.enabled)
                            .padding(.top, block.paragraphBreak ? 8 : 0)
                        }
                    }
                case .table(let rows):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                            ForEach(Array(rows.enumerated()), id: \.offset) { rowIndex, row in
                                GridRow {
                                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                        Text(Self.inline(cell))
                                            .font(rowIndex == 0 ? .caption.bold() : .caption)
                                            .fixedSize(horizontal: true, vertical: false)
                                    }
                                }
                                if rowIndex == 0 { Divider() }
                            }
                        }
                        .padding(10)
                    }
                    .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
                    .background(Color.tCard)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                case .quote(let inner):
                    // Quotes are marked by a left vertical rule, not a filled surface (to read
                    // distinctly from the code/table surfaces). Do not dim the body color —
                    // inkSub is 3.62:1 against bg in light mode, below WCAG AA (4.5:1)
                    // (measured with actual token values). The rule and indent are enough to
                    // signal a quote. The body recurses into MarkdownText itself so headings,
                    // lists, and nested quotes all get the existing handling. Placing the type
                    // itself in a `some View` body makes the Body type infinitely recursive and
                    // fails to compile, so erase the type with AnyView only here
                    AnyView(MarkdownText(inner, depth: depth + 1))
                        .padding(.leading, 15)   // 3pt rule + 12pt gap
                        // Putting the rule in an HStack lets the Shape greedily expand the row
                        // height. With overlay, the content's height is proposed as-is and
                        // only the rule stretches
                        .overlay(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 1.5)
                                .fill(Color.tTint.opacity(0.3))
                                .frame(width: 3)
                        }
                }
            }
        }
    }

    /// Display block. internal + Equatable so tests can poke at the assembled result
    enum Segment: Equatable { case prose(String), code(String), table([[String]]), quote(String) }

    var segments: [Segment] {
        var out: [Segment] = []
        var isCode = false
        var buf: [String] = []
        func flush() {
            let joined = buf.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty { out.append(isCode ? .code(joined) : .prose(joined)) }
            buf = []
        }
        let lines = text.components(separatedBy: "\n")
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                flush()
                isCode.toggle()
                i += 1
                continue
            }
            // Quote detection: group consecutive `>` lines into one block (per-line splitting
            // breaks up the vertical rule). The body has one level of markers stripped and
            // recurses into MarkdownText at render time
            if !isCode, depth < Self.maxQuoteDepth, let q = Self.quoteBlock(lines, from: i) {
                flush()
                out.append(.quote(q.body))
                i = q.next
                continue
            }
            // Table detection: consecutive lines starting with |, second line a separator row (only |, -, :, spaces)
            if !isCode, trimmed.hasPrefix("|"),
               i + 1 < lines.count,
               Self.isTableSeparator(lines[i + 1]) {
                flush()
                var rows: [[String]] = [Self.tableCells(trimmed)]
                i += 2   // discard the separator row
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    guard t.hasPrefix("|") else { break }
                    rows.append(Self.tableCells(t))
                    i += 1
                }
                out.append(.table(rows))
                continue
            }
            buf.append(line)
            i += 1
        }
        flush()
        return out
    }

    static func isTableSeparator(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.hasPrefix("|") || t.contains("-") else { return false }
        let allowed = Set("|-: ")
        return !t.isEmpty && t.contains("-") && t.allSatisfy { allowed.contains($0) }
    }

    /// Strip exactly one level of quote marker. nil if not a quote line.
    /// Up to 3 leading spaces are allowed (4 spaces is indented code in CommonMark);
    /// only one space after `>` is consumed (to preserve nested-list indentation
    /// like `> - a` / `>   - b`). Only one level is stripped; any remaining `>`
    /// is consumed by the recursive inner pass
    static func strippingQuoteMarker(_ line: String) -> String? {
        guard let r = line.range(of: #"^ {0,3}> ?"#, options: .regularExpression) else { return nil }
        return String(line[r.upperBound...])
    }

    /// Group the quote lines starting at lines[start] into one block. Returns the body
    /// with one marker level stripped, plus the line index to continue from.
    /// Lazy continuation (the CommonMark rule treating `>`-less lines as quote
    /// continuations) is not adopted — keep the boundaries explicit
    static func quoteBlock(_ lines: [String], from start: Int) -> (body: String, next: Int)? {
        guard start < lines.count, strippingQuoteMarker(lines[start]) != nil else { return nil }
        var body: [String] = []
        var i = start
        while i < lines.count, let stripped = strippingQuoteMarker(lines[i]) {
            body.append(stripped)
            i += 1
        }
        return (body.joined(separator: "\n"), i)
    }

    static func tableCells(_ line: String) -> [String] {
        var cells = line.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
        if cells.first?.isEmpty == true { cells.removeFirst() }
        if cells.last?.isEmpty == true { cells.removeLast() }
        return cells
    }

    /// A display line of prose. paragraphBreak = there was a blank line right before (start of a paragraph)
    struct ProseBlock: Equatable {
        let text: String
        let paragraphBreak: Bool
    }

    /// Split prose into display lines. Blank lines are not emitted as lines; instead
    /// the next line gets paragraphBreak, converted into wider spacing. Leading indentation is preserved
    static func proseBlocks(_ s: String) -> [ProseBlock] {
        var out: [ProseBlock] = []
        var pendingBreak = false
        for raw in s.components(separatedBy: "\n") {
            if raw.trimmingCharacters(in: .whitespaces).isEmpty {
                pendingBreak = !out.isEmpty
                continue
            }
            out.append(ProseBlock(text: raw, paragraphBreak: pendingBreak))
            pendingBreak = false
        }
        return out
    }

    /// Horizontal rule (thematic break). A line of 3+ of a single kind of - * _ (spaces in between allowed)
    static func isThematicBreak(_ line: String) -> Bool {
        line.range(of: #"^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$"#,
                   options: .regularExpression) != nil
    }

    /// Decompose an ATX heading line. Up to 3 leading spaces + 1–6 `#` + whitespace + body
    /// (trailing closing #s are dropped). No whitespace, as in `#hashtag`, is not a heading
    static func heading(_ line: String) -> (level: Int, body: String)? {
        guard let r = line.range(of: #"^ {0,3}(#{1,6})[ \t]+"#, options: .regularExpression) else {
            return nil
        }
        let level = line[r].filter { $0 == "#" }.count
        var body = String(line[r.upperBound...])
        // Drop closing #s (a run of only #s preceded by whitespace)
        if let close = body.range(of: #"[ \t]+#+[ \t]*$"#, options: .regularExpression) {
            body.removeSubrange(close)
        }
        body = body.trimmingCharacters(in: .whitespaces)
        guard !body.isEmpty else { return nil }
        return (level, body)
    }

    /// Interpret the heading body as inline markdown, then apply the heading font to the whole
    /// (inline bold spans pin 17pt explicitly, so without this override only the bold parts of a heading shrink)
    static func headingText(level: Int, _ body: String) -> AttributedString {
        var out = inline(body)
        out.font = headingFont(level: level)
        return out
    }

    /// Heading sizes. Against 17pt body: h1 22 / h2 20 / h3 18 / h4+ 17 (bold only).
    /// At chat width, the steps must stay small or h1 looks detached
    static func headingFont(level: Int) -> Font {
        switch level {
        case 1: return .tiny(22, weight: .bold, relativeTo: .title2)
        case 2: return .tiny(20, weight: .bold, relativeTo: .title3)
        case 3: return .tiny(18, weight: .bold, relativeTo: .headline)
        default: return .tiny(17, weight: .bold, relativeTo: .headline)
        }
    }

    /// Decompose a list-item line (for hanging indent).
    /// Markers are - * katakana middle dot (U+30FB) • ‣ and "digits + . / )". indent = leading space count
    static func listItem(_ line: String) -> (indent: Int, marker: String, body: String)? {
        let indent = line.prefix { $0 == " " || $0 == "\t" }.count
        let rest = String(line.dropFirst(indent))
        // Only a lone marker + whitespace counts (does not pick up the * in "**bold**" or "2 ** 3")
        guard let r = rest.range(of: #"^([-*\x{30FB}•‣]|\d{1,2}[.)])[ \t]+"#, options: .regularExpression) else {
            return nil
        }
        let marker = String(rest[r]).trimmingCharacters(in: .whitespaces)
        let body = String(rest[r.upperBound...])
        guard !body.isEmpty else { return nil }
        return (indent, marker, body)
    }

    /// Inter ships its own huge monochrome glyphs (1.35em square, dipping below the
    /// baseline) even for characters whose default presentation is emoji, such as
    /// ⬜ (U+2B1C), and a font that has the character wins over the emoji fallback —
    /// so drawn as-is the line height balloons and wrapping breaks.
    /// Append VS16 (U+FE0F) to pin rendering to Apple Color Emoji.
    static func forcingEmojiPresentation(_ s: String) -> String {
        guard s.unicodeScalars.contains(where: { $0.properties.isEmojiPresentation }) else { return s }
        let scalars = Array(s.unicodeScalars)
        var out = String.UnicodeScalarView()
        for (i, sc) in scalars.enumerated() {
            out.append(sc)
            // Skin-tone modifiers are themselves emoji-presentation but must not get a VS16 appended
            guard sc.properties.isEmojiPresentation,
                  !(0x1F3FB...0x1F3FF).contains(sc.value) else { continue }
            // If followed by a variation selector, skin-tone modifier, or ZWJ, do not break the existing sequence
            if i + 1 < scalars.count {
                let next = scalars[i + 1].value
                if next == 0xFE0E || next == 0xFE0F || next == 0x200D
                    || (0x1F3FB...0x1F3FF).contains(next) { continue }
            }
            out.append("\u{FE0F}")
        }
        return String(out)
    }

    /// Interpret inline markdown while preserving newlines. Broken syntax comes out as plain text.
    /// CommonMark refuses to recognize emphasis when the closing ** is preceded by
    /// punctuation and followed by a CJK character (the right-flanking rule), e.g. a
    /// full-width close paren before ** with a hiragana particle after it — so **
    /// alone is interpreted by hand first, then the rest (*italic*, `code`, links, etc.)
    /// is handed to the parser
    static func inline(_ s: String) -> AttributedString {
        var out = AttributedString()
        let forced = forcingEmojiPresentation(s)
        var rest = Substring(forced)
        while let r = rest.range(of: #"\*\*(?!\s)[^*\n]+?(?<!\s)\*\*"#, options: .regularExpression) {
            out += parseInline(String(rest[..<r.lowerBound]))
            var bold = parseInline(String(rest[r].dropFirst(2).dropLast(2)))
            bold.inlinePresentationIntent = .stronglyEmphasized
            // SwiftUI's bold conversion (symbolic trait) does not propagate to the
            // Japanese side of the mixed-font cascade: Inter gets bold while the
            // Japanese text is left Regular (found on device). Specify the mixed font
            // with an explicit weight directly so Japanese renders in Noto Bold too
            bold.font = .tiny(17, weight: .bold)
            out += bold
            rest = rest[r.upperBound...]
        }
        out += parseInline(String(rest))
        return underliningLinks(trimmingLinkPunctuation(out))
    }

    /// Underline links. Color alone is hard to tell from surrounding prose and reads
    /// as "text that happens to be blue" (the official Claude app underlines too)
    static func underliningLinks(_ input: AttributedString) -> AttributedString {
        var out = input
        for run in input.runs where run.link != nil {
            out[run.range].underlineStyle = .single
        }
        return out
    }

    /// For bare-URL autolinks like "(https://example.com/)", the GFM extension
    /// swallows the trailing close paren and punctuation into the URL (yielding 404s).
    /// Only runs whose display string equals the URL (autolinks) are targeted:
    /// strip trailing punctuation from the link. Close brackets are stripped only
    /// when unbalanced within the URL
    static func trimmingLinkPunctuation(_ input: AttributedString) -> AttributedString {
        var out = input
        for run in input.runs {
            guard let url = run.link else { continue }
            let text = String(input.characters[run.range])
            // Explicit [label](URL) links are left alone, as the author intended
            guard url.absoluteString == text
                || url.absoluteString.removingPercentEncoding == text else { continue }
            let keep = text.count - Self.trailingLinkJunkCount(text)
            guard keep < text.count else { continue }
            guard keep > 0, let trimmedURL = URL(string: String(text.prefix(keep))) else { continue }
            // Attribute-only changes, so indices stay valid
            let cut = out.index(run.range.upperBound, offsetByCharacters: keep - text.count)
            out[cut..<run.range.upperBound].link = nil
            out[run.range.lowerBound..<cut].link = trimmedURL
        }
        return out
    }

    /// Number of punctuation characters to strip from the end of a link. Sentence
    /// punctuation is stripped unconditionally; brackets only when the matching
    /// opening bracket is absent from the URL (unbalanced)
    static func trailingLinkJunkCount(_ text: String) -> Int {
        // CJK punctuation (ideographic full stop/comma, corner brackets, full-width
        // parens) is written as escapes to keep the source ASCII and unambiguous
        let punctuation: Set<Character> = [".", ",", ";", ":", "!", "?", "\u{3002}", "\u{3001}", "…"]
        let brackets: [Character: Character] = [
            ")": "(", "]": "[", "\u{FF09}": "\u{FF08}",
            "\u{300D}": "\u{300C}", "\u{300F}": "\u{300E}",
        ]
        var chars = Array(text)
        var count = 0
        while let last = chars.last {
            if punctuation.contains(last) {
                chars.removeLast(); count += 1; continue
            }
            if let open = brackets[last],
               chars.filter({ $0 == last }).count > chars.filter({ $0 == open }).count {
                chars.removeLast(); count += 1; continue
            }
            break
        }
        return count
    }

    private static func parseInline(_ s: String) -> AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        return (try? AttributedString(markdown: s, options: options)) ?? AttributedString(s)
    }
}
