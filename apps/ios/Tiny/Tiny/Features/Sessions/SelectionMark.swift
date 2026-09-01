import SwiftUI

/// The tick at the front of a row in selection mode. Takes over the slot of the unread dot / spinner
struct SelectionMark: View {
    let id: String
    let selected: Bool
    /// false = this row cannot be picked (running / in the CLI): faded, and the row ignores taps
    var enabled: Bool = true

    var body: some View {
        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 22))
            .foregroundStyle(selected ? Color.tTint : Color.tInkSub)
            .opacity(enabled ? 1 : 0.3)
            .frame(width: 22, height: 22)
            .contentTransition(.symbolEffect(.replace))
            .accessibilityIdentifier("selectionMark_\(id)")
            .accessibilityLabel(enabled ? (selected ? "Selected" : "Not selected")
                                        : "Can't be archived while it is running")
    }
}
