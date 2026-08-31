import SwiftUI

struct EventRow: View {
    let record: EventRecord
    /// Thumbnail fetch for user-attached images (ChatModel.attachedImage). nil falls back to showing the count
    var loadImage: ((String) async -> UIImage?)?
    let onOpenFile: (String, String, String) -> Void   // fileId, mime, displayName

    var body: some View {
        switch record.event {
        case .userMessage(let text, let imageCount, let imageFileIds):
            UserBubble(text: text, imageCount: imageCount,
                       time: Self.timeText(record.createdAt),
                       imageFileIds: imageFileIds,
                       loadImage: loadImage,
                       onTapImage: { id in onOpenFile(id, "image/jpeg", "photo.jpg") })

        case .assistantText(let text):
            MarkdownText(text)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .toolStarted, .toolFinished:
            // Tool calls are converted to the collapsed display (ToolSummaryRow) on the ChatView side
            EmptyView()

        case .turnCompleted(let cost, _, _):
            // Meta info (glanced-at text) gets letter spacing for an "engraved" feel;
            // body text (read text) is untouched (the grammar of MHdT's 0.2em price
            // display: labels uppercase + 0.18em, digits 0.12em)
            HStack {
                Image(systemName: "checkmark.circle").foregroundStyle(Color.tRunning)
                Text("Done").font(.caption).textCase(.uppercase).kerning(1.8)
                if let cost {
                    Text(String(format: "$%.2f", cost)).font(.caption2).foregroundStyle(Color.tInkSub)
                        .fontDesign(.monospaced).kerning(1.3)
                }
                Text(Self.timeText(record.createdAt)).font(.caption2).foregroundStyle(Color.tInkSub)
                    .fontDesign(.monospaced).kerning(1.3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

        case .turnFailed(let reason):
            Label(reason.contains("interrupt") || reason.contains("abort") ? "Stopped" : "Failed: \(reason)",
                  systemImage: "xmark.circle")
                .font(.caption).foregroundStyle(Color.tRuby)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .authError(let message):
            VStack(alignment: .leading, spacing: 4) {
                Label("Authentication error", systemImage: "person.crop.circle.badge.exclamationmark")
                    .font(.caption.bold()).foregroundStyle(Color.tRuby)
                Text("Run `tiny profiles login <name>` on your Mac.\n\(message)")
                    .font(.caption2).foregroundStyle(Color.tInkSub)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

        case .fileSent(let fileId, let mime, let caption, let name):
            // name is an absolute path on the Mac. Display the basename
            Button {
                onOpenFile(fileId, mime, (name as NSString).lastPathComponent)
            } label: {
                HStack {
                    Image(systemName: iconName(mime: mime)).font(.title3)
                    VStack(alignment: .leading) {
                        Text((name as NSString).lastPathComponent).font(.callout.bold()).lineLimit(1)
                            .fontDesign(.monospaced)
                        if let caption {
                            Text(caption).font(.caption).foregroundStyle(Color.tInkSub).lineLimit(1)
                        }
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(Color.tInkSub)
                }
                .padding(12)
                .background(Color.tCard)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
            }
            .buttonStyle(.plain)

        case .sessionStateChanged(let status):
            Text(status == "detached" ? "— Handed off to CLI —" : "— Resumed in app —")
                .font(.caption2).foregroundStyle(Color.tInkSub)
                .textCase(.uppercase).kerning(1.5)
                .frame(maxWidth: .infinity, alignment: .center)

        case .turnStarted, .permissionRequested, .permissionResolved, .unknown:
            // turnStarted is the progress indicator, permissions are banners, and
            // AskUserQuestion answers are converted by buildChatItems into .qa cards
            EmptyView()
        }
    }

    private func iconName(mime: String) -> String {
        if mime.hasPrefix("image/") { return "photo" }
        if mime == "text/html" { return "doc.richtext" }
        if mime == "application/pdf" { return "doc.text.image" }
        return "doc"
    }

    /// ISO8601 (with milliseconds) → HH:mm if today, otherwise M/d HH:mm
    static func timeText(_ iso: String) -> String {
        guard let date = parseISO(iso) else { return "" }
        return timeText(date)
    }

    static func timeText(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "M/d HH:mm"
        return f.string(from: date)
    }

    static func parseISO(_ iso: String) -> Date? {
        let withFrac = ISO8601DateFormatter()
        withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFrac.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        if let d = plain.date(from: iso) { return d }
        // The usage API's resets_at has 6 fractional digits (2026-08-27T09:10:00.308722+00:00),
        // which ISO8601DateFormatter cannot read — drop the fraction and retry
        let stripped = iso.replacingOccurrences(of: #"\.\d+"#, with: "", options: .regularExpression)
        return plain.date(from: stripped)
    }
}

/// User bubble. Shared between event rows (EventRow) and the just-sent optimistic
/// display (ChatView's pendingSends) so the styles match exactly when one replaces the other
struct UserBubble: View {
    let text: String
    let imageCount: Int
    let time: String
    /// For the just-sent optimistic display (shows the on-hand images as-is)
    var localImages: [UIImage] = []
    /// For history events (re-fetched from fileId)
    var imageFileIds: [String] = []
    var loadImage: ((String) async -> UIImage?)?
    var onTapImage: ((String) -> Void)?

    /// One image goes large; multiple drop to a size that fits side by side.
    /// 4 images (attachment cap) × 96 overflows the narrowest device (375pt − padding 32 = 343),
    /// and even one overflowing row makes the whole vertical ScrollView move
    /// horizontally (measured) — so fit within 4 × 76 + spacing 6 × 4 (Spacer included) = 328
    private var thumbSide: CGFloat {
        switch max(localImages.count, imageFileIds.count) {
        case ...1: return 180
        case 2...3: return 96
        default: return 76
        }
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if !localImages.isEmpty {
                HStack(spacing: 6) {
                    Spacer(minLength: 0)
                    ForEach(Array(localImages.enumerated()), id: \.offset) { _, img in
                        Image(uiImage: img)
                            .resizable().scaledToFill()
                            .frame(width: thumbSide, height: thumbSide)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                    }
                }
            } else if !imageFileIds.isEmpty, let loadImage {
                HStack(spacing: 6) {
                    Spacer(minLength: 0)
                    ForEach(imageFileIds, id: \.self) { id in
                        RemoteImageThumb(fileId: id, side: thumbSide, load: loadImage)
                            .onTapGesture { onTapImage?(id) }
                    }
                }
            } else if imageCount > 0 {
                // Fallback for old-server events (no fileId)
                Label("\(imageCount) image(s)", systemImage: "photo")
                    .font(.caption).foregroundStyle(Color.tInkSub)
            }
            HStack {
                Spacer(minLength: 48)
                Text(MarkdownText.forcingEmojiPresentation(text))
                    .lineSpacing(4)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Color.tTint)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 18))
                    .textSelection(.enabled)
            }
            Text(time)
                .font(.caption2).foregroundStyle(Color.tInkSub)
                .fontDesign(.monospaced).kerning(1.3)
        }
    }
}

/// Thumbnail loaded asynchronously from a fileId. Card-colored placeholder while loading
private struct RemoteImageThumb: View {
    let fileId: String
    let side: CGFloat
    let load: (String) async -> UIImage?
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Color.tCard.overlay(ProgressView())
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .task(id: fileId) { image = await load(fileId) }
    }
}
