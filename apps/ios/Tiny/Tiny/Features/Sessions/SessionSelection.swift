import Foundation

extension SessionRecord {
    /// A running or CLI-attached conversation must not vanish from the list mid-work: the server
    /// refuses those with 409, and every way of archiving in the app (swipe, multi-select) checks this first
    var canArchive: Bool { status != .running && status != .detached }
}

/// Which rows are ticked while a session list is in selection mode. A plain value the view keeps as
/// @State. It only remembers ids, so the list underneath can keep refreshing (4-second polling)
/// without losing the selection; `chosen(from:where:)` re-derives what is actually actionable at the moment of use
struct SessionSelection: Equatable {
    private(set) var ids: Set<String> = []

    var isEmpty: Bool { ids.isEmpty }
    func contains(_ id: String) -> Bool { ids.contains(id) }

    mutating func toggle(_ id: String) {
        if !ids.insert(id).inserted { ids.remove(id) }
    }
    mutating func select(_ id: String) { ids.insert(id) }
    mutating func selectAll(_ candidates: [SessionRecord]) { ids.formUnion(candidates.map(\.id)) }
    mutating func clear() { ids = [] }

    /// The ticked ids that are still in `sessions` and still eligible, in list order. A row that
    /// disappeared, or turned ineligible after being ticked (a session that started running), drops out
    func chosen(from sessions: [SessionRecord], where eligible: (SessionRecord) -> Bool) -> [String] {
        sessions.filter { ids.contains($0.id) && eligible($0) }.map(\.id)
    }

    /// Every candidate is ticked. False for no candidates — there is nothing to deselect
    func allSelected(among candidates: [SessionRecord]) -> Bool {
        !candidates.isEmpty && candidates.allSatisfy { ids.contains($0.id) }
    }
}
