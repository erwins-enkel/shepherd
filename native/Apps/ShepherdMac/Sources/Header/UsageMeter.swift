import SwiftUI
import ShepherdKit

/// One rate-limit window as a bar. `5H` and `WK` are the web's codes for the five-hour and weekly
/// windows (`src/usage-limits.ts:6-9`) — codes, not copy, so they are not translated; the localized
/// name goes in the accessibility label.
struct UsageBar: Identifiable {
    let id: String
    let nameKey: StaticString
    let pct: Double
    let stale: Bool
}

enum UsageMeter {
    /// `gaugeColor` (`ui/src/lib/components/usage-gauges.ts:297-306`). Strictly greater-than, so
    /// exactly 90 and exactly 50 stay in the lower tier. A stale comment in the web's
    /// `TopBar.svelte` claims an "amber 75-90" band; it is wrong, and this is the real ladder.
    static func gaugeColor(_ pct: Double) -> Color {
        if pct > 90 { return .red }
        if pct > 50 { return .orange }
        return .secondary
    }

    /// `pct` arrives already computed server-side as a 0..100 used-percentage.
    static func fill(_ pct: Double) -> Double { min(max(pct, 0), 100) / 100 }

    /// The two windows in the web's order, skipping one the server has no data for. An
    /// api-key-mode server reports no windows at all.
    static func bars(_ limits: UsageLimits) -> [UsageBar] {
        guard !limits.subscriptionOnly else { return [] }
        var bars: [UsageBar] = []
        if let window = limits.session5h {
            bars.append(
                .init(
                    id: "5H", nameKey: "usage_limits_window_5h", pct: window.pct,
                    stale: limits.stale))
        }
        if let window = limits.week {
            bars.append(
                .init(
                    id: "WK", nameKey: "usage_limits_window_week", pct: window.pct,
                    stale: limits.stale))
        }
        return bars
    }

    /// What to say when there is no bar to draw; `nil` means the bars speak for themselves.
    static func notice(_ limits: UsageLimits) -> String? {
        if limits.subscriptionOnly { return L.t("usage_subscription_only") }
        if bars(limits).isEmpty { return L.t("usage_limits_no_data") }
        return nil
    }
}

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
