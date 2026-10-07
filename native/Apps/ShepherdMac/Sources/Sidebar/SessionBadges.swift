import ShepherdAppCore
import SwiftUI
import ShepherdKit

struct SessionBadgeStack: View {
    let badges: [SessionBadge]
    var onSelect: ((String) -> Void)? = nil

    var body: some View {
        if !badges.isEmpty {
            SessionBadgeLayout {
                ForEach(badges) { badge in
                    if let onSelect, badge.id == "critic" || badge.id == "manual-steps" {
                        Button { onSelect(badge.id) } label: { chip(badge) }
                            .buttonStyle(.plain)
                    } else if let url = badge.url {
                        Link(destination: url) { chip(badge) }.buttonStyle(.plain)
                    } else { chip(badge) }
                }
            }
        }
    }

    private func chip(_ badge: SessionBadge) -> some View {
        HStack(spacing: 4) {
            Text(verbatim: badge.text).foregroundStyle(ShepherdPalette.badgeTint(badge.tint))
            ForEach(badge.markers) { marker in
                if let symbol = marker.symbol {
                    Image(systemName: symbol).foregroundStyle(ShepherdPalette.badgeTint(marker.tint))
                        .accessibilityLabel(Text(verbatim: marker.text))
                        .help(marker.text)
                } else { Text(verbatim: marker.text).foregroundStyle(ShepherdPalette.badgeTint(marker.tint)) }
            }
        }
        .font(.system(size: 10, weight: .semibold, design: .monospaced))
        .lineLimit(1)
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .overlay { RoundedRectangle(cornerRadius: 3)
            .stroke(ShepherdPalette.badgeStroke(badge.tint), lineWidth: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("herd-badge-\(badge.id)")
    }
}

/// Keep every badge visible in the narrow sidebar instead of hiding the tail in a scroller.
private struct SessionBadgeLayout: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? subviews.reduce(0) { $0 + $1.sizeThatFits(.unspecified).width + 4 }
        return arrangement(subviews, width: width).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let layout = arrangement(subviews, width: bounds.width)
        for (index, position) in layout.positions.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y),
                anchor: .topLeading, proposal: ProposedViewSize(width: min(bounds.width,
                    subviews[index].sizeThatFits(.unspecified).width), height: nil))
        }
    }

    private func arrangement(_ subviews: Subviews, width: CGFloat) -> (positions: [CGPoint], size: CGSize) {
        var positions: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: min(width, view.sizeThatFits(.unspecified).width), height: nil))
            if x > 0, x + size.width > width {
                x = 0; y += rowHeight + 4; rowHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            x += size.width + 4
            rowHeight = max(rowHeight, size.height)
        }
        return (positions, CGSize(width: width, height: y + rowHeight))
    }
}
