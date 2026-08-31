import SwiftUI

/// Wording of the Running row — Claude Code's own status line reads "(5m 58s · ↓ 16.4k tokens)".
/// Kept free of SwiftUI so the formatting is pinned by tests
enum ActivityFormat {
    /// "42s" under a minute, "5m 58s" under an hour, "1h 02m" beyond
    static func elapsed(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded(.down)))
        if total < 60 { return "\(total)s" }
        if total < 3600 { return "\(total / 60)m \(total % 60)s" }
        return String(format: "%dh %02dm", total / 3600, (total % 3600) / 60)
    }

    /// "980 tokens", "16.4k tokens", "1.2M tokens"
    static func tokens(_ n: Int) -> String {
        if n < 1000 { return "\(n) tokens" }
        if n < 1_000_000 { return String(format: "%.1fk tokens", Double(n) / 1000) }
        return String(format: "%.1fM tokens", Double(n) / 1_000_000)
    }

    /// "Running… · 5m 58s · ↓ 16.4k tokens". Pieces the server does not know are left out
    static func line(since: Date?, outputTokens: Int?, now: Date) -> String {
        var parts = ["Running…"]
        if let since { parts.append(elapsed(now.timeIntervalSince(since))) }
        if let outputTokens, outputTokens > 0 { parts.append("↓ " + tokens(outputTokens)) }
        return parts.joined(separator: " · ")
    }
}

/// The Running row: spinner, elapsed clock (ticks locally every second), output so far, and Stop.
/// Shown for any turn in progress — one sent from here or one typed into the CLI
struct ActivityRow: View {
    let since: Date?
    let outputTokens: Int?
    let onStop: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            HStack(spacing: 8) {
                ProgressView()
                Text(ActivityFormat.line(since: since, outputTokens: outputTokens, now: context.date))
                    .font(.caption)
                    .foregroundStyle(Color.tInkSub)
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .lineLimit(1)
                Spacer()
                Button("Stop", action: onStop)
                    .font(.caption)
                    .foregroundStyle(Color.tRuby)
            }
        }
    }
}
