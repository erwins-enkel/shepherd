import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

struct HeavySlotEntryTests {
    private func snapshot(enabled: Bool = true) throws -> Components.Schemas.HeavySlotSnapshot {
        try JSONDecoder().decode(Components.Schemas.HeavySlotSnapshot.self, from: Data(#"""
        {"enabled":\#(enabled),"capacity":1,
         "holders":[{"sessionId":"a","command":"swift test","startedAt":1000,"rssBytes":1073741824}],
         "waiters":[{"sessionId":"b","position":5,"reason":"slot"},{"sessionId":"c","position":6,"reason":"pressure"}],
         "brake":{"active":false,"reason":null},
         "pressure":{"ramAvailableBytes":null,"ramTotalBytes":null,"swapUsedBytes":null,"swapTotalBytes":null,"memFullAvg10":null,"memBrakeThreshold":null,"cpuSomeAvg10":null},
         "memoryBySource":{"agentsBytes":null,"foreignBytes":null,"foreignTop":[]},
         "lastResults":[]}
        """#.utf8))
    }

    @Test func holderAndWaitersGetTheirOwnLine() throws {
        let snap = try snapshot()
        #expect(HeavySlotEntry.of(snap, session: PreviewData.session(id: "a"))
            == .holding(command: "swift test", startedAt: 1000, rssBytes: 1_073_741_824))
        #expect(HeavySlotEntry.of(snap, session: PreviewData.session(id: "b")) == .waiting(position: 5, pressure: false))
        #expect(HeavySlotEntry.of(snap, session: PreviewData.session(id: "c")) == .waiting(position: 6, pressure: true))
        #expect(HeavySlotEntry.of(snap, session: PreviewData.session(id: "other")) == nil)
    }

    @Test func switchedOffSlotOrArchivedSessionShowsNothing() throws {
        #expect(HeavySlotEntry.of(try snapshot(enabled: false), session: PreviewData.session(id: "a")) == nil)
        #expect(HeavySlotEntry.of(nil, session: PreviewData.session(id: "a")) == nil)
        let archived = PreviewData.session(id: "b", status: SessionStatus(known: .archived))
        #expect(HeavySlotEntry.of(try snapshot(), session: archived) == nil)
    }
}
