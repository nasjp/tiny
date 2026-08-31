import Foundation

/// What the Usage screen shows for a profile that returned no numbers.
/// The server says why (`problem`), how to fix it (`hint`), and keeps the raw upstream text
/// (`detail`) — a 401 body belongs behind a disclosure, not across the screen.
struct UsageFailure: Equatable {
    enum Tone: Equatable {
        /// Needs the person to do something (sign in again, look at the Mac)
        case alert
        /// Nothing is wrong: this login just has no usage to report
        case muted
    }

    let title: String
    let hint: String?
    let detail: String?
    let tone: Tone

    /// Longest first line worth printing. Beyond this the text is elided and kept in Details
    static let titleLimit = 120

    static func from(_ error: Error) -> UsageFailure {
        guard let api = error as? APIError else {
            return UsageFailure(title: error.localizedDescription, hint: nil, detail: nil, tone: .alert)
        }
        // A tinyd older than the `problem` field answers with the raw text and nothing else:
        // keep one line on screen and move the rest out of sight
        guard let problem = api.problem else {
            let oneLine = api.message.trimmingCharacters(in: .whitespacesAndNewlines)
            let short = oneLine.count > titleLimit || oneLine.contains("\n")
            return UsageFailure(
                title: short ? String(oneLine.prefix(titleLimit - 1)) + "…" : oneLine,
                hint: nil,
                detail: short ? api.message : nil,
                tone: .alert)
        }
        return UsageFailure(
            title: api.message,
            hint: api.hint,
            detail: api.detail,
            tone: problem == "unavailable" || problem == "unsupported" ? .muted : .alert)
    }
}
