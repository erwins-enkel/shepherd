import Testing
import ShepherdKit

@testable import ShepherdAppCore

extension CoreSeamTests {
/// The rules are `layoutEpicFlow` / `firstParallelStage` in ui/src/lib/epic-flow.ts.
struct EpicFlowTests {
    private func numbers(_ flow: EpicFlow) -> [[Int]] { flow.stages.map { $0.children.map(\.number) } }

    @Test func stagesFollowTheLongestBlockerPath() throws {
        let flow = EpicFlow(try EpicFixtures.content111().children)
        #expect(numbers(flow) == [[101], [102, 103], [104, 105, 106, 108, 109, 110], [107]])
        #expect(flow.stage(of: 107) == 4)
        #expect(flow.stage(of: 999) == nil)
        #expect(flow.stages.map(\.parallel) == [false, true, true, false])
        #expect(flow.blockers[107] == [106])
    }

    @Test func firstParallelAndCurrentStageSkipMergedChildren() throws {
        let fresh = EpicFlow(try EpicFixtures.content111().children)
        #expect(fresh.firstParallelStage == 2)
        #expect(fresh.currentStage == 1)
        let later = EpicFlow(try EpicFixtures.content111([101: "merged", 102: "merged", 103: "merged"]).children)
        #expect(later.firstParallelStage == 3)
        #expect(later.currentStage == 3)
        let done = EpicFlow(try EpicFixtures.content111(EpicFixtures.allMerged()).children)
        #expect(done.currentStage == nil)
        #expect(done.firstParallelStage == nil)
    }

    @Test func selfReferencesOutsideEdgesAndDuplicatesAreIgnored() throws {
        let flow = EpicFlow(try EpicFixtures.epic([
            .init(number: 1, blockedBy: [1, 99]),
            .init(number: 2, blockedBy: [1, 1]),
        ]).children)
        #expect(numbers(flow) == [[1], [2]])
        #expect(flow.blockers[1] == [])
        #expect(flow.blockers[2] == [1])
    }

    @Test func aCycleDropsTheEdgeThatClosesIt() throws {
        // Walked in order: #1 visits #2, whose edge back to #1 closes the cycle and is skipped.
        let flow = EpicFlow(try EpicFixtures.epic([
            .init(number: 1, blockedBy: [2]),
            .init(number: 2, blockedBy: [1]),
        ]).children)
        #expect(numbers(flow) == [[2], [1]])
    }

    @Test func withinAStageChildrenFollowTheirBlockersRows() throws {
        let flow = EpicFlow(try EpicFixtures.epic([
            .init(number: 1), .init(number: 2),
            .init(number: 3, blockedBy: [2]), .init(number: 4, blockedBy: [1]),
        ]).children)
        #expect(numbers(flow) == [[1, 2], [4, 3]])
    }

    @Test func noChildrenNoStages() {
        let flow = EpicFlow([])
        #expect(flow.stages.isEmpty)
        #expect(flow.currentStage == nil)
    }
}
}
