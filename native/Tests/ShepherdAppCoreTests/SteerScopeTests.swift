import XCTest
import ShepherdKit
@testable import ShepherdAppCore

@MainActor
final class SteerScopeTests: XCTestCase {
    private func steer(_ id: String, bar: Bool = true, repos: [String]? = nil,
                       providers: [AgentProvider]? = nil) -> ComposeSteer {
        ComposeSteer(id: id, label: id, text: "do \(id)", inSteerBar: bar, onIssues: !bar,
            repos: repos, agentProviders: providers)
    }

    func testScopeMatchesTheWebRule() {
        let steers = [
            steer("universal"),
            steer("issues-only", bar: false),
            steer("shepherd-only", repos: ["shepherd"]),
            steer("other-repo", repos: ["other"]),
            steer("codex-only", providers: [.codex]),
            steer("empty-lists", repos: [], providers: []),
        ]
        let ids = { (repo: String?, provider: String?) in
            SteerScope.barSteers(steers, repoName: repo, provider: provider).map(\.id)
        }
        XCTAssertEqual(ids("shepherd", "claude"), ["universal", "shepherd-only", "empty-lists"])
        XCTAssertEqual(ids("shepherd", "codex"), ["universal", "shepherd-only", "codex-only", "empty-lists"])
        // An unknown repo name hides repo-scoped steers instead of treating them as universal.
        XCTAssertEqual(ids(nil, "claude"), ["universal", "empty-lists"])
        // No provider known: provider lists do not filter, like web's steerApplies.
        XCTAssertEqual(ids("other", nil), ["universal", "other-repo", "codex-only", "empty-lists"])
    }

    func testLibraryResolvesTheSessionRepoByPath() async {
        let library = SteerLibrary()
        await library.load(steers: { [self.steer("a", repos: ["shepherd"]), self.steer("b", repos: ["x"])] },
            repos: { ["/w/shepherd": "shepherd"] })
        XCTAssertEqual(SteerScope.barSteers(library.steers, repoName: library.repoNames["/w/shepherd"],
            provider: nil).map(\.id), ["a"])
        XCTAssertNil(library.loadError)
    }

    func testLibraryReportsALoadFailureButKeepsRepos() async {
        struct Boom: Error {}
        let library = SteerLibrary()
        await library.load(steers: { throw Boom() }, repos: { ["/p": "p"] })
        XCTAssertNotNil(library.loadError)
        XCTAssertEqual(library.repoNames, ["/p": "p"])
        XCTAssertTrue(library.loaded)
    }

}
