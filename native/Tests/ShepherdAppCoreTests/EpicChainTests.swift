import Testing
import ShepherdKit

@testable import ShepherdAppCore

extension CoreSeamTests {
/// The rules are `childUnlocks` (epic-child.ts), `epicMeter`, `runMs` and `stepTitle`
/// (epic-timing-text.ts) in ui/src/lib.
struct EpicChainTests {
    private func chain(_ number: Int, _ epic: Epic) throws -> EpicChain {
        try #require(EpicChain(number, flow: EpicFlow(epic.children), children: epic.children))
    }

    @Test func theFirstChildNeedsNothingAndFreesTwoInParallel() throws {
        let chain = try chain(101, EpicFixtures.content111())
        #expect(chain.needs.isEmpty)
        #expect(chain.stage == 1 && chain.stageCount == 4)
        #expect(chain.unlocks == [102, 103])
        #expect(chain.parallel == 2)
        #expect(!chain.isLast)
    }

    @Test func aMergedPredecessorIsMarkedAndTheFanOutCounts() throws {
        let chain = try chain(103, EpicFixtures.content111([101: "merged", 103: "running"]))
        #expect(chain.needs == [.init(number: 101, merged: true)])
        #expect(chain.stage == 2)
        #expect(chain.unlocks == [104, 105, 106, 108, 109, 110])
        #expect(chain.parallel == 6)
    }

    @Test func anOutOfOrderStartShowsTheOpenBlocker() throws {
        let chain = try chain(102, EpicFixtures.content111([102: "running"]))
        #expect(chain.needs == [.init(number: 101, merged: false)])
        #expect(chain.unlocks.isEmpty && chain.parallel == 0)
    }

    @Test func theLastChildIsMarkedOnceEveryOtherOneMerged() throws {
        var states = EpicFixtures.allMerged()
        states[107] = "running"
        let chain = try chain(107, EpicFixtures.content111(states))
        #expect(chain.isLast)
        #expect(chain.unlocks.isEmpty)
        #expect(chain.stage == 4 && chain.stageCount == 4)
    }

    @Test func aNumberOutsideTheEpicHasNoChain() throws {
        let epic = try EpicFixtures.content111()
        #expect(EpicChain(999, flow: EpicFlow(epic.children), children: epic.children) == nil)
    }

    @Test func meterTonesFollowEpicOrder() throws {
        let epic = try EpicFixtures.content111([101: "merged", 102: "in-review", 103: "ready"])
        #expect(EpicMeter.tones(epic.children)
            == [.merged, .inFlight, .rest, .rest, .rest, .rest, .rest, .rest, .rest, .rest])
        #expect(EpicMeter.tones(merged: 2, total: 4) == [.merged, .merged, .rest, .rest])
        #expect(EpicMeter.tones(merged: 0, total: 0).isEmpty)
    }

    @Test func theClockSubtractsPausesAndStandsStillWhilePaused() throws {
        func timing(_ fields: String) throws -> EpicTiming {
            try #require(try EpicFixtures.epic([.init(number: 1)], extra: ",\"timing\":{\(fields)}").timing)
        }
        let rest = "\"landingStartedAt\":null,\"landedAt\":null,\"agentMs\":0,\"idleMs\":0"
        let running = try timing("\"startedAt\":1000,\"pausedAt\":null,\"pausedMs\":200,\(rest)")
        #expect(EpicClock.runMs(running, now: 5_000) == 3_800)
        let paused = try timing("\"startedAt\":1000,\"pausedAt\":3000,\"pausedMs\":0,\(rest)")
        #expect(EpicClock.runMs(paused, now: 9_000) == 2_000)
        let never = try timing("\"startedAt\":null,\"pausedAt\":null,\"pausedMs\":0,\(rest)")
        #expect(EpicClock.runMs(never, now: 9_000) == 0)
    }

    @Test func titlesDropRedundantPrefixes() {
        #expect(EpicText.displayTitle("Epic: Content-Plan-Kalender") == "Content-Plan-Kalender")
        #expect(EpicText.displayTitle("EPIC:   Spuren") == "Spuren")
        #expect(EpicText.displayTitle("Epic:") == "Epic:")
        #expect(EpicText.displayTitle("Epics in iOS") == "Epics in iOS")
        #expect(EpicText.stepTitle("Stack-Angleichung (#158): Sortierung", parent: 158) == "Sortierung")
        #expect(EpicText.stepTitle("Stack (#1580): Sortierung", parent: 158) == "Stack (#1580): Sortierung")
        #expect(EpicText.stepTitle("Einplanen: je Konto", parent: 111) == "Einplanen: je Konto")
    }

    @Test func numberListsShowTwoThenACount() {
        #expect(EpicText.numbers([]) == "")
        #expect(EpicText.numbers([102]) == "#102")
        #expect(EpicText.numbers([102, 103]) == "#102 · #103")
        #expect(EpicText.numbers([104, 105, 106, 108]) == "#104 · #105 +2")
        #expect(EpicText.numbers([101], prefix: "✓ ") == "✓ #101")
    }
}
}
