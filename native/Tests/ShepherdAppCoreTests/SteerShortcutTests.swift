import ShepherdKit
import Testing
@testable import ShepherdAppCore

@Suite("Steer shortcuts")
struct SteerShortcutTests {
    private var steers: [ComposeSteer] {
        (0..<12).map { ComposeSteer(id: "s\($0)", label: "Steer \($0)", text: "Text \($0)",
            inSteerBar: true, onIssues: false) }
    }

    @Test(arguments: Array(0..<12))
    func firstNinePositionsOnly(index: Int) {
        #expect(SteerShortcuts.number(for: "s\(index)", in: steers) == (index < 9 ? index + 1 : nil))
    }

    @Test func searchPreservesBarShortcutsAndMatchesText() {
        let matches = SteerShortcuts.matches(steers, search: "  text 7  ")
        #expect(matches.map(\.id) == ["s7"])
        #expect(SteerShortcuts.number(for: "s7", in: steers) == 8)
        #expect(SteerShortcuts.number(for: "missing", in: steers) == nil)
        #expect(SteerShortcuts.matches(steers, search: " ").count == 12)
        #expect(SteerShortcuts.matches(steers, search: "STEER 2").map(\.id) == ["s2"])
    }

    @Test func shortcutsFollowScopedOrder() {
        var list = steers
        list[0].inSteerBar = false
        list[1].repos = ["other"]
        list[2].agentProviders = [.codex]
        let scoped = SteerScope.barSteers(list, repoName: "shepherd", provider: "claude")
        #expect(scoped.first?.id == "s3")
        #expect(SteerShortcuts.number(for: "s3", in: scoped) == 1)
        #expect(SteerShortcuts.number(for: "s11", in: scoped) == 9)
    }
}
