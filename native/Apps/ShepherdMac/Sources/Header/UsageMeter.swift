import ShepherdAppCore
import SwiftUI
import ShepherdKit

struct UsageMeterView: View {
    let limits: UsageLimits?

    var body: some View {
        if let limits {
            if let notice = UsageMeter.notice(limits) {
                Text(verbatim: notice)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("usage-notice")
            } else {
                HStack(spacing: 8) {
                    ForEach(UsageMeter.bars(limits)) { bar in
                        HStack(spacing: 4) {
                            Text(verbatim: bar.id)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                            GeometryReader { proxy in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(Color.secondary.opacity(0.18))
                                    Capsule()
                                        .fill(UsageMeter.gaugeColor(bar.pct))
                                        .frame(width: proxy.size.width * UsageMeter.fill(bar.pct))
                                }
                            }
                            .frame(height: 4)
                        }
                        .opacity(bar.stale ? 0.5 : 1)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(L.t(bar.nameKey)) \(Int(bar.pct.rounded()))%")
                        .accessibilityIdentifier("usage-bar-\(bar.id)")
                    }
                }
            }
        }
    }
}
