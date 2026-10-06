import ShepherdAppCore
import SwiftUI
import ShepherdKit

struct SessionBadgeStack: View {
    let badges: [SessionBadge]

    var body: some View {
        if !badges.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 4) {
                    ForEach(badges) { badge in
                        if let url = badge.url {
                            Link(destination: url) { chip(badge) }.buttonStyle(.plain)
                        } else { chip(badge) }
                    }
                }
            }
            .scrollIndicators(.never)
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
        .fixedSize()
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .overlay { RoundedRectangle(cornerRadius: 3)
            .stroke(ShepherdPalette.badgeStroke(badge.tint), lineWidth: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("herd-badge-\(badge.id)")
    }
}
