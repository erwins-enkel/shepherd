import Testing
@testable import Shepherd
@MainActor struct MergeOwedTests {
    @Test func owedIsNotLimitedToCurrentSessions() {
        #expect(MergeRules.owed([], repos: []).isEmpty)
        #expect(MergeModel.refreshEvents.contains("post-merge-steps:changed"))
        #expect(MergeModel.refreshEvents.contains("session:manual-steps"))
    }
}
