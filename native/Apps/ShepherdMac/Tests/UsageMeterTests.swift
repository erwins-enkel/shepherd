import SwiftUI
import Testing
import ShepherdKit

@testable import Shepherd

@MainActor
struct UsageMeterTests {
    private func limits(
        fiveHour: Double? = nil, week: Double? = nil, stale: Bool = false,
        subscriptionOnly: Bool = false
    ) -> UsageLimits {
        UsageLimits(
            session5h: fiveHour.map { .init(pct: $0, resetAt: 1) },
            week: week.map { .init(pct: $0, resetAt: 2) },
            perModelWeek: [], credits: nil, stale: stale, calibratedAt: nil,
            subscriptionOnly: subscriptionOnly)
    }

    // ui/src/lib/components/usage-gauges.ts:297-306 — strictly > 90 and > 50.
    @Test func gaugeColorLadderIsStrictlyGreaterThan() {
        #expect(UsageMeter.gaugeColor(91) == .red)
        #expect(UsageMeter.gaugeColor(90) == .orange)
        #expect(UsageMeter.gaugeColor(51) == .orange)
        #expect(UsageMeter.gaugeColor(50) == .secondary)
        #expect(UsageMeter.gaugeColor(0) == .secondary)
    }

    @Test func fillIsClampedToZeroAndOne() {
        #expect(UsageMeter.fill(-10) == 0)
        #expect(UsageMeter.fill(42) == 0.42)
        #expect(UsageMeter.fill(130) == 1)
    }

    @Test func barsAreFiveHourThenWeekAndSkipMissingWindows() {
        #expect(UsageMeter.bars(limits(fiveHour: 30)).map(\.id) == ["5H"])
        #expect(UsageMeter.bars(limits(fiveHour: 30, week: 70)).map(\.id) == ["5H", "WK"])
        #expect(UsageMeter.bars(limits(fiveHour: 30)).first?.pct == 30)
        #expect(UsageMeter.bars(limits(fiveHour: 30, stale: true)).first?.stale == true)
    }

    @Test func noticeCoversApiKeyModeAndNoWindowsAtAll() {
        let apiKey = limits(fiveHour: 30, subscriptionOnly: true)
        #expect(UsageMeter.bars(apiKey).isEmpty)
        #expect(UsageMeter.notice(apiKey) == L.t("usage_subscription_only"))
        #expect(UsageMeter.notice(limits()) == L.t("usage_limits_no_data"))
        #expect(UsageMeter.notice(limits(fiveHour: 30)) == nil)
    }
}
