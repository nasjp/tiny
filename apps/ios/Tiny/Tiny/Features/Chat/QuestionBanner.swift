import SwiftUI

/// AskUserQuestion answer UI. Styled after the official Claude Code app's card:
/// large rounded card / question set large / options as rule-separated rows (tap to
/// select, check shown) / Other expands into an input field on row tap / bottom-right ↑
/// confirms / × is deny (leave it to Claude).
/// Multiple questions are a one-at-a-time carousel, not stacked vertically
/// (selecting slides to the next question). While shown, ChatView hides the standard composer.
struct QuestionBanner: View {
    let permission: PendingPermission
    let onSubmit: ([String: String]) -> Void
    let onDismiss: () -> Void

    private let questions: [AskQuestion]
    @State private var selections: [Int: Set<Int>] = [:]
    @State private var otherExpanded: Set<Int> = []
    @State private var otherDrafts: [Int: String] = [:]
    @FocusState private var otherFocus: Int?
    // Current carousel page and travel direction (used for the slide direction)
    @State private var page = 0
    @State private var forward = true

    init(permission: PendingPermission,
         onSubmit: @escaping ([String: String]) -> Void,
         onDismiss: @escaping () -> Void) {
        self.permission = permission
        self.onSubmit = onSubmit
        self.onDismiss = onDismiss
        self.questions = AskUserQuestion.parse(permission.input)
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
                Text(currentHeader).font(.subheadline).foregroundStyle(Color.tInkSub)
                if questions.count > 1 {
                    Text("\(page + 1) / \(questions.count)")
                        .font(.caption).foregroundStyle(Color.tInkSub)
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
            // Show only the current question. Content-sized when it fits; scrolls only when long
            ViewThatFits(in: .vertical) {
                currentQuestion
                ScrollView { currentQuestion }.frame(maxHeight: 380)
            }
            .clipped()   // keep the push transition's slide inside the card
            HStack {
                if page > 0 {
                    Button {
                        forward = false
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

    private var currentQuestion: some View {
        questionSection(page)
            .id(page)   // break view identity on page change so the push transition kicks in
            .transition(.push(from: forward ? .trailing : .leading))
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func advance() {
        guard !isLastPage else { return }
        forward = true
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
                        .textSelection(.enabled)
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
