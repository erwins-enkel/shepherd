import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct SessionCardView: View {
    let card: IOSSessionListPresentation.Card
    var selected = false
    let select: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Button(action: select) {
            HStack(alignment: .top, spacing: 10) {
                status.frame(width: 12).padding(.top, 4)
                VStack(alignment: .leading, spacing: 5) {
                    ViewThatFits(in: .horizontal) {
                        titleLine
                        VStack(alignment: .leading, spacing: 3) {
                            title
                            age
                        }
                    }
                    if !card.session.prompt.isEmpty {
                        Text(verbatim: card.session.prompt)
                            .sessionFont().foregroundStyle(SessionListStyle.ink)
                            .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let summary = card.summary {
                        Text(verbatim: summary).sessionFont(label: true)
                            .foregroundStyle(SessionListStyle.muted)
                            .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                    }
                    SessionBadgeFlow(badges: card.badges)
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .center) { metadata; Spacer(minLength: 6); progress }
                        VStack(alignment: .leading, spacing: 5) { metadata; progress }
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? SessionListStyle.selected : SessionListStyle.panel)
            .overlay { Rectangle().stroke(selected ? SessionListStyle.brightLine : SessionListStyle.line, lineWidth: 1) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: accessibilityLabel))
        .accessibilityHint(L.t("native_ios_open_session_hint"))
        .accessibilityIdentifier("session-row-\(card.id)")
    }

    private var title: some View {
        Text(verbatim: card.session.name).sessionFont(weight: .semibold)
            .foregroundStyle(SessionListStyle.bright)
            .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
    private var age: some View {
        Text(verbatim: card.age).sessionFont(label: true).monospacedDigit()
            .foregroundStyle(SessionListStyle.ink).fixedSize()
    }
    private var titleLine: some View { HStack(alignment: .top, spacing: 8) { title; age } }
    private var metadata: some View {
        Text(verbatim: card.metadata).sessionFont(label: true)
            .foregroundStyle(SessionListStyle.muted).fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private var status: some View {
        if card.progress.terminal != nil {
            Circle().stroke(SessionListStyle.slate, lineWidth: 2).frame(width: 8, height: 8)
        } else if card.displayed.readyToMerge {
            Image(systemName: "checkmark").foregroundStyle(SessionListStyle.green)
        } else if card.displayed.status.known == .blocked {
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(SessionListStyle.red)
        } else if card.displayed.status.known == .done {
            Circle().stroke(SessionListStyle.slate, lineWidth: 2).frame(width: 8, height: 8)
        } else {
            Circle().fill(card.displayed.status.known == .running ? SessionListStyle.amber : SessionListStyle.slate)
                .frame(width: 8, height: 8)
        }
    }

    private var progress: some View {
        HStack(spacing: 3) {
            ForEach(card.progress.segments) { segment in
                RoundedRectangle(cornerRadius: 1)
                    .fill(segment.isHollow ? .clear : SessionListStyle.badgeTint(segment.color))
                    .frame(width: 10, height: segment.height)
                    .overlay {
                        RoundedRectangle(cornerRadius: 1)
                            .stroke(SessionListStyle.badgeTint(segment.color), lineWidth: segment.outlineWidth)
                    }
            }
        }
        .fixedSize()
    }

    private var accessibilityLabel: String {
        [card.session.desig, card.session.name,
         card.progress.terminal != nil ? card.progress.accessibilityLabel
            : card.displayed.readyToMerge ? L.t("status_ready_to_merge") : SessionStatusStyle.label(card.displayed.status),
         L.t("native_ios_session_age", card.age), card.session.prompt, card.summary ?? "",
         card.badges.map { ([$0.text] + $0.markers.map(\.text)).joined(separator: ", ") }.joined(separator: ", "),
         card.metadata, card.progress.accessibilityLabel]
            .filter { !$0.isEmpty }.joined(separator: ". ")
    }
}

struct SessionBadgeFlow: View {
    let badges: [SessionBadge]
    var body: some View {
        SessionWrappingLayout(spacing: 4) {
            ForEach(badges) { badge in
                HStack(spacing: 4) {
                    Text(verbatim: badge.text.uppercased())
                    ForEach(badge.markers) { marker in
                        if let symbol = marker.symbol {
                            Image(systemName: symbol).foregroundStyle(SessionListStyle.badgeTint(marker.tint))
                        } else {
                            Text(verbatim: marker.text).foregroundStyle(SessionListStyle.badgeTint(marker.tint))
                        }
                    }
                }
                .sessionFont(label: true, weight: .medium)
                .foregroundStyle(SessionListStyle.badgeTint(badge.tint))
                .padding(.horizontal, 5).padding(.vertical, 2)
                .overlay { RoundedRectangle(cornerRadius: 2).stroke(SessionListStyle.badgeTint(badge.tint), lineWidth: 0.5) }
                .accessibilityLabel(Text(verbatim: badge.text))
            }
        }
    }
}

/// Wrap rather than crop or horizontally hide attention badges at larger text sizes.
struct SessionWrappingLayout: Layout {
    let spacing: CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(subviews, width: proposal.width ?? .infinity).size
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let layout = arrange(subviews, width: bounds.width)
        for (index, point) in layout.points.enumerated() {
            let size = subviews[index].sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            subviews[index].place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y),
                proposal: ProposedViewSize(size))
        }
    }
    private func arrange(_ subviews: Subviews, width: CGFloat) -> (size: CGSize, points: [CGPoint]) {
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxWidth: CGFloat = 0
        var points: [CGPoint] = []
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
            if x > 0, x + size.width > width { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            points.append(CGPoint(x: x, y: y))
            maxWidth = max(maxWidth, x + size.width)
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return (CGSize(width: maxWidth, height: y + rowHeight), points)
    }
}
