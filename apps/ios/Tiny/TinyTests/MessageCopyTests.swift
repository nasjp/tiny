import XCTest
import UIKit
@testable import Tiny

/// Regression net for a device report: long-press → Copy on a message put a rich-text (RTFD)
/// item on the pasteboard, and pasting it elsewhere produced a file reference, not the words.
/// Message copy must write plain text and nothing else
final class MessageCopyTests: XCTestCase {
    func testCopyWritesPlainTextOnly() {
        UIPasteboard.general.items = []
        MessageCopy.copy("hello **world**\nsecond line")
        XCTAssertEqual(UIPasteboard.general.string, "hello **world**\nsecond line")
        XCTAssertEqual(UIPasteboard.general.numberOfItems, 1)
        let types = UIPasteboard.general.types
        XCTAssertFalse(types.contains { $0.lowercased().contains("rtf") }, "\(types)")
        XCTAssertTrue(types.allSatisfy { $0.contains("text") || $0.contains("string") }, "\(types)")
    }
}
