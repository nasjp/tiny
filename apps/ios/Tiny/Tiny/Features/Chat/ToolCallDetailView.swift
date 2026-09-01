import SwiftUI

/// One tool call, opened from the tool sheet: what it was asked to do and what it printed.
/// Mirrors the official app's Bash detail (Command / Output)
struct ToolCallDetailView: View {
    let call: ToolCall

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                ForEach(Array(call.inputFields.enumerated()), id: \.offset) { _, field in
                    section(field.label) {
                        codeBlock(field.text)
                    }
                }
                // A failed call's text is its error (the official app titles it so, in its warning colour)
                section(call.isError ? "Error" : "Output", tint: call.isError ? Color.tDetached : Color.tInkSub) {
                    if let output = call.output {
                        codeBlock(output)
                            .accessibilityIdentifier("toolOutput")
                        if call.outputTruncated {
                            Text("Output truncated at 20,000 characters")
                                .font(.caption)
                                .foregroundStyle(Color.tInkSub)
                        }
                    } else if !call.finished {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Running…")
                        }
                        .font(.callout)
                        .foregroundStyle(Color.tInkSub)
                        .accessibilityIdentifier("toolOutputRunning")
                    } else {
                        Text("No output was recorded")
                            .font(.callout)
                            .foregroundStyle(Color.tInkSub)
                            .accessibilityIdentifier("toolOutputMissing")
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
        .background(Color.tBg)
        .navigationTitle(call.name)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func section<Content: View>(_ title: String, tint: Color = Color.tInkSub, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.tinyCaption2)
                .kerning(1.2)
                .textCase(.uppercase)
                .foregroundStyle(tint)
            content()
        }
    }

    /// Monospace text in a card; wraps long lines, copies as plain text on long press
    private func codeBlock(_ text: String) -> some View {
        Text(text)
            .font(.system(.footnote, design: .monospaced))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Color.tCard, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .copyable(text)
    }
}
