import XCTest
import SwiftUI
@testable import Tiny

/// Regression net for the device report of the chat wobbling horizontally. Two causes:
/// (1) A row measured wider than the proposal makes the whole vertical ScrollView move horizontally too (the 4-image bubble)
/// (2) The code/table horizontal ScrollViews bounce even when content fits (SwiftUI default)
final class ChatRowWidthTests: XCTestCase {
    private let width: CGFloat = 343   // iPhone SE/mini (375pt) − padding 16 both sides. Narrowest device

    private func measuredWidth<V: View>(_ v: V) -> CGFloat {
        let host = UIHostingController(rootView: v.frame(maxWidth: .infinity, alignment: .leading))
        return host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).width
    }

    func testChatRowsNeverWiderThanProposal() {
        let img = UIGraphicsImageRenderer(size: CGSize(width: 200, height: 200)).image { _ in }
        let rows: [(String, AnyView)] = [
            ("prose+heading", AnyView(MarkdownText("Conclusion first. **Matsuya closes at 19:30 today.**\n\n### Option 1: Kanda Yabu Soba (2-min walk)\n\nThe only equivalent alternative."))),
            ("long-url", AnyView(MarkdownText("See: https://tabelog.com/tokyo/A1310/A131002/13000340/dtlrvwlst/B123456789/?use_type=0&lid=0000000000&smp=1"))),
            ("long-token", AnyView(MarkdownText("ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ"))),
            ("list", AnyView(MarkdownText("- The first item is a really long sentence that is long enough to need wrapping, truly long indeed\n  - child item"))),
            ("hr", AnyView(MarkdownText("above\n\n---\n\nbelow"))),
            ("wide-table", AnyView(MarkdownText("| Name | Hours | Payment | Notes |\n|---|---|---|---|\n| Kanda Yabu Soba | 11:30-20:30 nonstop (L.O. 20:00) | cards and transit IC | 97 seats, fast turnover. Closed Wednesdays |"))),
            ("long-code", AnyView(MarkdownText("```\nconst veryLongIdentifierName = someFunctionCall(argumentOne, argumentTwo, argumentThree);\n```"))),
            ("quote", AnyView(MarkdownText("> The quoted line is a really long sentence that is long enough to need wrapping, truly long indeed\n> second line"))),
            // Nesting recurses into MarkdownText itself (type-erased via AnyView). If this renders, the recursion holds
            ("nested-quote", AnyView(MarkdownText("> outer\n>> The inner quote is a really long sentence that is long enough to need wrapping, truly long indeed\n> back to outer"))),
            ("quote-with-blocks", AnyView(MarkdownText("> ### Heading\n>\n> - An item that is a really long sentence that is long enough to need wrapping, truly long\n>\n> ```\n> const veryLongIdentifierName = someFunctionCall(argumentOne, argumentTwo);\n> ```"))),
            ("bubble-4img-local", AnyView(UserBubble(text: "photos", imageCount: 4, time: "16:36", localImages: [img, img, img, img]))),
            ("bubble-4img-remote", AnyView(UserBubble(text: "photos", imageCount: 4, time: "16:36",
                                                      imageFileIds: ["a", "b", "c", "d"], loadImage: { _ in nil }))),
            ("bubble-long", AnyView(UserBubble(text: "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ", imageCount: 0, time: "16:36"))),
            ("peer-card", AnyView(PeerMessageCard(from: "a-teammate-with-a-really-long-identifier-name", summary: "A summary line that is long enough to need wrapping on the narrowest device for sure",
                                                  text: "| Name | Hours |\n|---|---|\n| Kanda Yabu Soba | 11:30-20:30 nonstop (L.O. 20:00) and then some more text |"))),
        ]
        for (label, v) in rows {
            let w = measuredWidth(v)
            XCTAssertLessThanOrEqual(w, width, "\(label) is wider than the proposal (\(w) > \(width))")
        }
    }

    private func scrollViews(in v: UIView) -> [UIScrollView] {
        var out: [UIScrollView] = []
        if let s = v as? UIScrollView { out.append(s) }
        for c in v.subviews { out += scrollViews(in: c) }
        return out
    }

    func testInnerHorizontalScrollViewsDoNotBounceWhenContentFits() {
        let host = UIHostingController(rootView:
            MarkdownText("```\ncd foo\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |")
                .frame(maxWidth: .infinity, alignment: .leading))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = CGRect(x: 0, y: 0, width: 370, height: 800)
        host.view.setNeedsLayout(); host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        let inner = scrollViews(in: host.view)
        XCTAssertEqual(inner.count, 2, "expects the two horizontal ScrollViews of the code block and the table")
        for s in inner {
            XCTAssertLessThan(s.contentSize.width, s.bounds.width, "precondition: content fits the frame")
            XCTAssertFalse(s.alwaysBounceHorizontal, "draggable sideways despite fitting (the wobble's cause)")
        }
    }
}
