import SwiftUI

/// AskUserQuestion answer UI. Styled after the official Claude Code app's card:
/// large rounded card / question set large / options as rule-separated rows (tap to
/// select, check shown) / Other expands into an input field on row tap / bottom-right ↑
/// confirms / × is deny (leave it to Claude).
/// Multiple questions are a one-at-a-time carousel, not stacked vertically
/// (selecting slides to the next question). While shown, ChatView hides the standard composer.
struct QuestionBanner: View {
    let onSubmit: ([String: String]) -> Void
    let onDismiss: () -> Void

    private let questions: [AskQuestion]
    @State private var selections: [Int: Set<Int>] = [:]
    @State private var otherExpanded: Set<Int> = []
    @State private var otherDrafts: [Int: String] = [:]
    @FocusState private var otherFocus: Int?
    // Current carousel page, the live drag on the strip, and what each page and the card measure
    @State private var page = 0
    @State private var drag: CGFloat = 0
    @State private var cardWidth: CGFloat = 0
    @State private var pageHeights: [Int: CGFloat] = [:]

    /// The questions to ask. Both sources land here: a permission tiny drove itself, and a
    /// cli_question the CLI asked on its own
    init(questions: [AskQuestion],
         onSubmit: @escaping ([String: String]) -> Void,
         onDismiss: @escaping () -> Void) {
        self.onSubmit = onSubmit
        self.onDismiss = onDismiss
        self.questions = questions
    }

    init(permission: PendingPermission,
         onSubmit: @escaping ([String: String]) -> Void,
         onDismiss: @escaping () -> Void) {
        self.init(questions: AskUserQuestion.parse(permission.input), onSubmit: onSubmit, onDismiss: onDismiss)
    }

    private var isLastPage: Bool { page >= questions.count - 1 }

    private func answered(_ qi: Int) -> Bool {
        !(selections[qi] ?? []).isEmpty ||
            !(otherDrafts[qi] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var allAnswered: Bool { questions.indices.allSatisfy(answered) }

    private var currentHeader: String {
        guard questions.indices.contains(page), !questions[page].header.isEmpty else { return "Question" }
        return questions[page].header
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                // Crossfade with the slide instead of snapping a beat ahead of it
                Text(currentHeader).font(.subheadline).foregroundStyle(Color.tInkSub)
                    .contentTransition(.opacity)
                if questions.count > 1 {
                    Text("\(page + 1) / \(questions.count)")
                        .font(.caption).foregroundStyle(Color.tInkSub)
                        .contentTransition(.opacity)
                }
                Spacer()
                Button { onDismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.footnote.bold())
                        .foregroundStyle(Color.tInkSub)
                        .frame(width: 30, height: 30)
                        .background(Circle().fill(Color.tLine.opacity(0.6)))
                }
                .accessibilityIdentifier("questionDismissButton")
            }
            carousel
            HStack {
                if page > 0 {
                    Button {
                        withAnimation(.spring(duration: 0.35)) { page -= 1 }
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(Color.tInkSub)
                            .frame(width: 32, height: 32)
                            .background(Circle().fill(Color.tLine.opacity(0.6)))
                    }
                    .accessibilityIdentifier("questionBackButton")
                }
                Spacer()
                if isLastPage {
                    // Same design as the composer's send button (circle + bold ↑)
                    Button {
                        onSubmit(buildAnswers())
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(allAnswered ? .white : Color.tInkSub)
                            .frame(width: 32, height: 32)
                            .background(Circle().fill(allAnswered ? Color.tTint : Color.tLine))
                    }
                    .disabled(!allAnswered)
                    .accessibilityIdentifier("questionSubmitButton")
                } else {
                    Button { advance() } label: {
                        Image(systemName: "arrow.right")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(answered(page) ? .white : Color.tInkSub)
                            .frame(width: 32, height: 32)
                            .background(Circle().fill(answered(page) ? Color.tTint : Color.tLine))
                    }
                    .disabled(!answered(page))
                    .accessibilityIdentifier("questionNextButton")
                }
            }
        }
        .padding(18)
        .background(RoundedRectangle(cornerRadius: 24, style: .continuous)
            .fill(Color.tCard))
        .padding(.horizontal, 10)
        .padding(.top, 4)
    }

    /// Every question laid side by side, the strip slid to the current one — a real carousel.
    /// It replaced `.transition(.push)`: inside `ViewThatFits` that transition never animated
    /// (a UI test watching the frames saw the next question appear with no travel at all), which
    /// is what made answering a question set feel like a hard cut
    private var carousel: some View {
        VStack(spacing: 0) {
            // Color is flexible, so it reports the width the card gives its content
            Color.clear.frame(height: 0)
                .background(GeometryReader { g in
                    Color.clear.preference(key: CardWidthKey.self, value: g.size.width)
                })
            HStack(alignment: .top, spacing: 0) {
                ForEach(questions.indices, id: \.self) { qi in
                    page(qi)
                }
            }
            .offset(x: QuestionCarousel.offset(page: page, drag: drag, width: cardWidth))
            .frame(width: cardWidth, alignment: .leading)
        }
        .frame(height: visibleHeight)
        .clipped()
        .contentShape(Rectangle())
        // Swipe between questions. Only where the page fits: a page that scrolls needs the
        // vertical drag for itself, and two competing gestures make both feel broken
        .gesture(swipe, including: needsScroll(page) ? .subviews : .all)
        .onPreferenceChange(CardWidthKey.self) { cardWidth = $0 }
        .onPreferenceChange(PageHeightKey.self) { heights in
            for (qi, h) in heights where h > 0 { pageHeights[qi] = h }
        }
    }

    /// Height of the card's question area: the current page's own height, capped so a long
    /// question scrolls inside the card instead of pushing the buttons off screen
    private var visibleHeight: CGFloat? {
        let h = pageHeights[page] ?? 0
        return h == 0 ? nil : min(h, QuestionCarousel.maxPageHeight)
    }

    private func needsScroll(_ qi: Int) -> Bool {
        (pageHeights[qi] ?? 0) > QuestionCarousel.maxPageHeight
    }

    @ViewBuilder
    private func page(_ qi: Int) -> some View {
        let content = questionSection(qi)
            .background(GeometryReader { g in
                Color.clear.preference(key: PageHeightKey.self, value: [qi: g.size.height])
            })
        Group {
            if needsScroll(qi) {
                ScrollView { content }
            } else {
                content
            }
        }
        .frame(width: cardWidth, alignment: .topLeading)
    }

    private var swipe: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { v in
                guard abs(v.translation.width) > abs(v.translation.height) else { return }
                drag = QuestionCarousel.rubberBanded(v.translation.width, page: page,
                                                     count: questions.count, width: cardWidth)
            }
            .onEnded { v in
                let target = QuestionCarousel.target(page: page, translation: v.translation.width,
                                                     width: cardWidth, count: questions.count)
                withAnimation(.spring(duration: 0.35)) {
                    page = target
                    drag = 0
                }
            }
    }

    private func advance() {
        guard !isLastPage else { return }
        withAnimation(.spring(duration: 0.35)) { page += 1 }
    }

    private func questionSection(_ qi: Int) -> some View {
        let q = questions[qi]
        return VStack(alignment: .leading, spacing: 6) {
            Text(q.question)
                .font(.title3.weight(.semibold))
                .padding(.bottom, 6)
            VStack(spacing: 0) {
                ForEach(q.options.indices, id: \.self) { oi in
                    optionRow(qi: qi, oi: oi)
                    Divider()
                }
                otherRow(qi)
            }
        }
    }

    private func optionRow(qi: Int, oi: Int) -> some View {
        let q = questions[qi]
        let opt = q.options[oi]
        let selected = selections[qi]?.contains(oi) ?? false
        return Button {
            if q.multiSelect {
                var s = selections[qi] ?? []
                if selected { s.remove(oi) } else { s.insert(oi) }
                selections[qi] = s
            } else {
                selections[qi] = selected ? [] : [oi]
                // Single select shows the check for a beat before moving to the next question (the last one confirms via ↑)
                if !selected, qi < questions.count - 1 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        if page == qi { advance() }
                    }
                }
            }
        } label: {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(opt.label)
                        .font(.body.weight(.medium))
                        .foregroundStyle(selected ? Color.tTint : .primary)
                    if !opt.description.isEmpty {
                        Text(opt.description).font(.subheadline).foregroundStyle(Color.tInkSub)
                    }
                }
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.body.bold()).foregroundStyle(Color.tTint)
                }
            }
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("questionOption\(qi)_\(oi)")
    }

    /// Other sits as a row and expands into an input field on tap (showing a TextField
    /// from the start both reads as an option and pops the keyboard on a mis-tap — this avoids both)
    @ViewBuilder
    private func otherRow(_ qi: Int) -> some View {
        if otherExpanded.contains(qi) {
            TextField("Type your own answer…", text: otherBinding(qi), axis: .vertical)
                .focused($otherFocus, equals: qi)
                .font(.body)
                .padding(.vertical, 12)
                .accessibilityIdentifier("questionOtherField\(qi)")
        } else {
            Button {
                otherExpanded.insert(qi)
                otherFocus = qi
            } label: {
                Text("Other")
                    .font(.body)
                    .foregroundStyle(Color.tInkSub)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 12)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("questionOtherButton\(qi)")
        }
    }

    private func otherBinding(_ qi: Int) -> Binding<String> {
        Binding(get: { otherDrafts[qi] ?? "" }, set: { otherDrafts[qi] = $0 })
    }

    /// answers = {question text: selected label}. Multi-select joins with commas; free input is appended at the end
    private func buildAnswers() -> [String: String] {
        var out: [String: String] = [:]
        for (qi, q) in questions.enumerated() {
            var labels = (selections[qi] ?? []).sorted().map { q.options[$0].label }
            let other = (otherDrafts[qi] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !other.isEmpty { labels.append(other) }
            if !labels.isEmpty { out[q.question] = labels.joined(separator: ", ") }
        }
        return out
    }
}

/// The carousel's arithmetic, kept out of the view so it can be tested without a screen
enum QuestionCarousel {
    /// A page taller than this scrolls inside the card instead of growing it
    static let maxPageHeight: CGFloat = 380

    static func offset(page: Int, drag: CGFloat, width: CGFloat) -> CGFloat {
        -CGFloat(page) * width + drag
    }

    /// Dragging past the first or last question pulls against a spring instead of tearing the
    /// strip off the card
    static func rubberBanded(_ translation: CGFloat, page: Int, count: Int, width: CGFloat) -> CGFloat {
        let atStart = page == 0 && translation > 0
        let atEnd = page >= count - 1 && translation < 0
        return atStart || atEnd ? translation * 0.35 : translation
    }

    /// Where a swipe lands: a quarter of the card's width is enough to turn the page
    static func target(page: Int, translation: CGFloat, width: CGFloat, count: Int) -> Int {
        let threshold = max(width * 0.25, 40)
        if translation <= -threshold { return min(page + 1, count - 1) }
        if translation >= threshold { return max(page - 1, 0) }
        return page
    }
}

private struct CardWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        let next = nextValue()
        if next > 0 { value = next }
    }
}

private struct PageHeightKey: PreferenceKey {
    static let defaultValue: [Int: CGFloat] = [:]
    static func reduce(value: inout [Int: CGFloat], nextValue: () -> [Int: CGFloat]) {
        value.merge(nextValue()) { _, new in new }
    }
}

/// Card keeping an answered AskUserQuestion in history (the official app's design:
/// "Question" label + question in gray + the chosen answer below)
struct QuestionAnswerCard: View {
    let pairs: [QAPair]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Question").font(.subheadline).foregroundStyle(Color.tInkSub)
            ForEach(Array(pairs.enumerated()), id: \.offset) { _, p in
                VStack(alignment: .leading, spacing: 4) {
                    Text(p.question).font(.callout).foregroundStyle(Color.tInkSub)
                    Text(p.answer).font(.body.weight(.medium))
                        .copyable(p.answer)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(Color.tCard))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(.quaternary))
    }
}

/// A question the CLI is asking its person, shown while it waits. The phone cannot answer it —
/// the CLI owns the prompt — so this is the answer card's read-only twin: the question, the
/// options it offered, and where the answer has to be given
struct CLIQuestionCard: View {
    let questions: [AskQuestion]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 6) {
                Text("Question").font(.subheadline).foregroundStyle(Color.tInkSub)
                Image(systemName: "desktopcomputer")
                    .font(.caption2).foregroundStyle(Color.tInkSub)
                Text("answer in the CLI").font(.caption).foregroundStyle(Color.tInkSub)
            }
            ForEach(Array(questions.enumerated()), id: \.offset) { _, q in
                VStack(alignment: .leading, spacing: 6) {
                    Text(q.question).font(.callout).foregroundStyle(Color.tInkSub)
                        .copyable(q.question)
                    ForEach(Array(q.options.enumerated()), id: \.offset) { _, o in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: "circle")
                                .font(.system(size: 9)).foregroundStyle(Color.tInkSub)
                            Text(o.label).font(.body.weight(.medium))
                        }
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(Color.tCard))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(.quaternary))
    }
}
