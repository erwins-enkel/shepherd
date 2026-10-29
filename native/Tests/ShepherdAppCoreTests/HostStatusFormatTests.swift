import Testing
@testable import ShepherdAppCore

struct HostStatusFormatTests {
    @Test func absentMetricsStayUnknownRatherThanZero() {
        #expect(HostStatusFormat.bytes(nil) == "—")
        #expect(HostStatusFormat.percent(nil) == "—")
        #expect(HostStatusFormat.ramUsed(available: nil, total: 4096) == "—")
        #expect(HostStatusFormat.ramUsed(available: 1024, total: 0) == "—")
        #expect(HostStatusFormat.bytes(0) != "—")
    }

    @Test func ramShowsUsedShareButRetainsSmallPressureReadings() {
        #expect(HostStatusFormat.ramUsed(available: 1024, total: 4096) == HostStatusFormat.percent(75))
        #expect(HostStatusFormat.percent(0.03) != HostStatusFormat.percent(0))
    }
}
