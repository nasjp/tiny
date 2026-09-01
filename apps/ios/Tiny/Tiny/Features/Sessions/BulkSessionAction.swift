import Foundation

/// One server call per session, run together, reporting exactly which ones failed so the caller
/// can put those rows back (the rest are archived for real and must stay gone)
enum BulkSessionAction {
    struct Failure: Equatable {
        let id: String
        let message: String
    }

    /// Calls `perform` for every id concurrently — URLSession's per-host connection limit paces the
    /// requests. Never throws: one failure must not stop the others, and the caller wants the whole
    /// list of what did not happen. Failures come back in the order of `ids`
    static func run(_ ids: [String], perform: @escaping @Sendable (String) async throws -> Void) async -> [Failure] {
        await withTaskGroup(of: (Int, Failure?).self, returning: [Failure].self) { group in
            for (index, id) in ids.enumerated() {
                group.addTask {
                    do {
                        try await perform(id)
                        return (index, nil)
                    } catch {
                        return (index, Failure(id: id, message: error.localizedDescription))
                    }
                }
            }
            var failed: [(Int, Failure)] = []
            for await (index, failure) in group {
                if let failure { failed.append((index, failure)) }
            }
            return failed.sorted { $0.0 < $1.0 }.map(\.1)
        }
    }

    /// "Couldn't archive 2 of 5 sessions." plus the first error — the same tinyd answered every
    /// request, so one message is what identifies the cause. Empty when nothing failed
    static func failureMessage(verb: String, failures: [Failure], total: Int) -> String {
        guard let first = failures.first else { return "" }
        let head = total == 1
            ? "Couldn't \(verb) the session."
            : "Couldn't \(verb) \(failures.count) of \(total) sessions."
        return head + "\n" + first.message
    }

    /// "Archive" (nothing ticked) / "Archive 1 Session" / "Archive 3 Sessions"
    static func buttonTitle(verb: String, count: Int) -> String {
        switch count {
        case 0: return verb
        case 1: return "\(verb) 1 Session"
        default: return "\(verb) \(count) Sessions"
        }
    }
}
