import SwiftUI
import UIKit

/// Card-style horizontal swipe (replacement for the standard swipeActions).
/// Instead of the standard square button, the card itself follows the finger and a
/// round action button wells up from behind (same manner as the Claude Code app's
/// session list).
/// - Release midway: springs to a snap position where the button is visible (tap the button to act)
/// - Past the threshold (45% of screen width): haptics fire, and on release the card
///   slides off-screen before action fires (full swipe)
/// - To coexist with the List's vertical scrolling, drags whose first displacement is
///   vertical-dominant are ignored
struct SwipeActionCard<Content: View>: View {
    let icon: String
    let tint: Color
    var enabled: Bool = true
    let action: () -> Void
    @ViewBuilder var content: () -> Content

    /// Current offset applied on screen (drag tracking + snap target)
    @State private var x: CGFloat = 0
    /// Offset committed when the finger lifts (0 = closed / -openWidth = button shown)
    @State private var baseX: CGFloat = 0
    /// Whether this drag counts as a horizontal swipe (decided by the first displacement's direction, then locked)
    @State private var horizontal: Bool?
    @State private var passedThreshold = false
    @State private var flying = false

    private let buttonSize: CGFloat = 52
    private let gap: CGFloat = 10
    private var openWidth: CGFloat { buttonSize + gap * 2 }
    private var screenWidth: CGFloat { UIScreen.main.bounds.width }
    private var flingThreshold: CGFloat { screenWidth * 0.45 }
    /// How far the button has emerged (0 = hidden, 1 = fully out). Used for scale and opacity
    private var progress: CGFloat { min(1, max(0, -x / openWidth)) }

    var body: some View {
        ZStack(alignment: .trailing) {
            actionButton
            content()
                .overlay {
                    // Only while open, catch taps to close (when closed, no overlay is
                    // placed at all so row-tap navigation is not blocked).
                    // MUST come before .offset — placed after, the overlay does not
                    // follow the card and stays at the original position (right on top
                    // of the round button), stealing its taps so tapping "only closes"
                    // (hit this on device)
                    if baseX != 0 {
                        Color.clear.contentShape(Rectangle())
                            .onTapGesture { snap(to: 0) }
                    }
                }
                .offset(x: x)
                .gesture(drag)
        }
        // Selection mode turns swiping off; a card left open (button showing) must close with it
        .onChange(of: enabled) { _, isEnabled in
            if !isEnabled, baseX != 0 { snap(to: 0) }
        }
    }

    private var actionButton: some View {
        Button { fling() } label: {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: buttonSize, height: buttonSize)
                .background(tint, in: Circle())
        }
        .buttonStyle(.plain)
        .padding(.trailing, gap)
        .scaleEffect(0.4 + 0.6 * progress)
        .opacity(progress)
        .allowsHitTesting(baseX != 0 && !flying)
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 25, coordinateSpace: .local)
            .onChanged { v in
                guard enabled, !flying else { return }
                if horizontal == nil {
                    horizontal = abs(v.translation.width) > abs(v.translation.height)
                }
                guard horizontal == true else { return }
                let raw = baseX + v.translation.width
                x = raw > 0 ? raw * 0.15 : raw   // rubber-band to the right
                let past = -x > flingThreshold
                if past != passedThreshold {
                    passedThreshold = past
                    // Tell the finger about threshold crossings. This one tap is the core of the "feel"
                    UIImpactFeedbackGenerator(style: past ? .medium : .light).impactOccurred()
                }
            }
            .onEnded { v in
                defer { horizontal = nil }
                guard enabled, !flying, horizontal == true else { return }
                if passedThreshold {
                    fling(velocity: v.velocity.width)
                } else if -x > openWidth * 0.6 {
                    snap(to: -openWidth)
                } else {
                    snap(to: 0)
                }
            }
    }

    private func snap(to target: CGFloat) {
        baseX = target
        withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) { x = target }
    }

    /// Full-swipe slide-out. Like the Apple standard (Mail's delete), the finger's
    /// velocity carries into the animation, exiting the screen in at most 0.16s
    /// (a spring with gooey deceleration is "slow and cheap" — settled by device feedback)
    private func fling(velocity: CGFloat = 0) {
        flying = true
        passedThreshold = false
        let remaining = max(1, screenWidth + x)   // x is negative; distance left to the left edge
        let duration = min(0.16, max(0.06, Double(remaining / max(abs(velocity), 1200))))
        withAnimation(.easeOut(duration: duration)) { x = -screenWidth }
        // Start removing the row just before the card fully exits (waiting longer drags)
        DispatchQueue.main.asyncAfter(deadline: .now() + duration * 0.85) { action() }
    }
}
