import SwiftUI
import ShepherdKit

/// One rate-limit window as a bar. `5H` and `WK` are the web's codes for the five-hour and weekly
/// windows (`src/usage-limits.ts:6-9`) — codes, not copy, so they are not translated; the localized
/// name goes in the accessibility label.
public struct UsageBar: Identifiable {
    public let id: String
    public let nameKey: StaticString
    public let pct: Double
    /// Epoch milliseconds when the window resets; `0` or past means unknown.
    public let resetAt: Int
    public let stale: Bool
}

public enum UsageMeter {
    /// `gaugeColor` (`ui/src/lib/components/usage-gauges.ts:297-306`). Strictly greater-than, so
    /// exactly 90 and exactly 50 stay in the lower tier. A stale comment in the web's
    /// `TopBar.svelte` claims an "amber 75-90" band; it is wrong, and this is the real ladder.
    public static func gaugeColor(_ pct: Double) -> Color {
        if pct > 90 { return .red }
        if pct > 50 { return .orange }
        return .secondary
    }

    /// `pct` arrives already computed server-side as a 0..100 used-percentage.
    public static func fill(_ pct: Double) -> Double { min(max(pct, 0), 100) / 100 }

    /// The two windows in the web's order, skipping one the server has no data for. An
    /// api-key-mode server reports no windows at all.
    public static func bars(_ limits: UsageLimits) -> [UsageBar] {
        guard !limits.subscriptionOnly else { return [] }
        var bars: [UsageBar] = []
        if let window = limits.session5h {
            bars.append(
                .init(
                    id: "5H", nameKey: "usage_limits_window_5h", pct: window.pct, resetAt: window.resetAt,
                    stale: limits.stale))
        }
        if let window = limits.week {
            bars.append(
                .init(
                    id: "WK", nameKey: "usage_limits_window_week", pct: window.pct, resetAt: window.resetAt,
                    stale: limits.stale))
        }
        return bars
    }

    /// The phone's warning line for a hot window. The top-level windows are Claude's (Codex reports
    /// its own under `providers`), so the agent is named; the reset time is added when it is known.
    public static func warning(_ bar: UsageBar, now: Date = Date()) -> String {
        let agent = L.t("native_compose_engine_claude")
        let pct = String(Int(bar.pct))
        let reset = Date(timeIntervalSince1970: Double(bar.resetAt) / 1000)
        if reset > now {
            return L.t("native_ios_usage_warning_reset", agent, L.t(bar.nameKey), pct,
                       reset.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute()))
        }
        return L.t("native_ios_usage_warning", agent, L.t(bar.nameKey), pct)
    }

    /// What to say when there is no bar to draw; `nil` means the bars speak for themselves.
    public static func notice(_ limits: UsageLimits) -> String? {
        if limits.subscriptionOnly { return L.t("usage_subscription_only") }
        if bars(limits).isEmpty { return L.t("usage_limits_no_data") }
        return nil
    }
}
