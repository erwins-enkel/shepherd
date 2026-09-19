import Testing
import ShepherdKit

@testable import Shepherd

@MainActor
struct SessionBadgesTests {
    private func session(
        research: Bool = false, terminal: Bool = false, paused: Bool = false, steps: Int = 0
    ) -> Session {
        var s = PreviewData.session(id: "a")
        s.research = research
        s.terminal = terminal
        s.autopilotPaused = paused
        s.manualSteps = (0..<steps).map { _ in .init() }
        return s
    }

    private func quotaBlock(_ kind: BlockReason.QuotaKindPayload.Value1Payload) -> BlockReason {
        BlockReason(
            shape: .init(value1: .quota), options: [], tail: [], quotaKind: .init(value1: kind))
    }

    @Test func badgesAppearOnlyForTheFlagsThatAreSet() {
        #expect(SessionBadges.items(for: session(), block: nil).isEmpty)
        let items = SessionBadges.items(
            for: session(research: true, terminal: true, paused: true, steps: 3), block: nil)
        #expect(items.map(\.id) == ["research", "terminal", "needs-you", "manual-steps"])
        #expect(items.last?.text.contains("3") == true)
    }

    @Test func aQuotaBlockAddsItsBadgeBeforeNeedsYouAndPlanIsNotOne() {
        #expect(
            SessionBadges.items(for: session(paused: true), block: quotaBlock(.review)).map(\.id)
                == ["quota", "needs-you"])
        #expect(SessionBadges.items(for: session(), block: quotaBlock(.plan)).isEmpty)
    }

    @Test func noBadgeTextLeaksARawKey() {
        let items = SessionBadges.items(
            for: session(research: true, terminal: true, paused: true, steps: 1),
            block: quotaBlock(.rework))
        for item in items { #expect(!item.text.contains("_"), "\(item.id) leaked a key") }
    }
}
