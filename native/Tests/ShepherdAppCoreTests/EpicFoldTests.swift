import Testing
import ShepherdKit

@testable import ShepherdAppCore

extension CoreSeamTests {
struct EpicFoldTests {
    private func fold(_ epic: Epic, shown: Set<Int>) -> EpicFold {
        EpicFold(flow: EpicFlow(epic.children), children: epic.children, shown: shown)
    }

    @Test func foldsEveryUnmergedChildWithoutARowByStage() throws {
        let fold = fold(try EpicFixtures.content111(), shown: [101])
        #expect(fold.count == 9)
        #expect(fold.stages.map(\.index) == [2, 3, 4])
        #expect(fold.stages.map(\.after) == [[101], [103], [106]])
        #expect(fold.stages[1].items.map(\.child.number) == [104, 105, 106, 108, 109, 110])
        #expect(fold.stages[0].items.map(\.unlocks) == [0, 6])
        #expect(fold.summary == .waiting(on: [101]))
    }

    @Test func readyChildrenLeadTheSummary() throws {
        let fold = fold(try EpicFixtures.content111([101: "merged", 102: "ready", 103: "running"]), shown: [103])
        #expect(fold.stages.first?.items.map(\.child.number) == [102])
        #expect(fold.summary == .ready(count: 1))
    }

    @Test func mergedBlockersLeaveNothingToWaitOn() throws {
        // #102 is folded and its only blocker #101 is merged: no open blocker to name.
        let fold = fold(try EpicFixtures.content111([101: "merged", 103: "merged"]), shown: [])
        #expect(fold.stages.first?.items.map(\.child.number) == [102])
        #expect(fold.summary == nil)
    }

    @Test func nothingFoldedNoSummary() throws {
        let fold = fold(try EpicFixtures.content111(EpicFixtures.allMerged()), shown: [])
        #expect(fold.count == 0)
        #expect(fold.summary == nil)
    }

    @Test func aDigestMatchesRowsBySessionThenIssue() throws {
        let digest = EpicDigest(try EpicFixtures.content111(sessions: [101: "s-101"]))
        #expect(digest.child(session: "s-101", issue: nil)?.number == 101)
        #expect(digest.child(session: "other", issue: 103)?.number == 103)
        #expect(digest.child(session: "other", issue: nil) == nil)
        #expect(digest.total == 10 && digest.merged == 0 && digest.inFlight == 1)
        #expect(digest.meter.first == .inFlight)
        #expect(digest.chain(101)?.unlocks == [102, 103])
        #expect(digest.fold(shown: [101]).count == 9)
    }
}
}
