import SwiftUI
import UIKit

/// Plain-text copy for chat messages.
/// SwiftUI's `.textSelection(.enabled)` Copy writes the styled text to the pasteboard as rich
/// text (RTFD), which other apps paste as a file reference instead of the words (device report).
/// Messages copy through here instead, and only as `public.utf8-plain-text`
enum MessageCopy {
    static func copy(_ text: String) {
        UIPasteboard.general.string = text
    }
}

extension View {
    /// Long-press → Copy for a whole message (the message text as-is, markdown markers included)
    func copyable(_ text: String) -> some View {
        contextMenu {
            Button {
                MessageCopy.copy(text)
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
        }
    }
}
