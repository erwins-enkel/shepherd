import XCTest
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSSteersTests: XCTestCase {
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
            IOSSteerScope.barSteers(steers, repoName: repo, provider: provider).map(\.id)
        }
        XCTAssertEqual(ids("shepherd", "claude"), ["universal", "shepherd-only", "empty-lists"])
        XCTAssertEqual(ids("shepherd", "codex"), ["universal", "shepherd-only", "codex-only", "empty-lists"])
        // An unknown repo name hides repo-scoped steers instead of treating them as universal.
        XCTAssertEqual(ids(nil, "claude"), ["universal", "empty-lists"])
        // No provider known: provider lists do not filter, like web's steerApplies.
        XCTAssertEqual(ids("other", nil), ["universal", "other-repo", "codex-only", "empty-lists"])
    }

    func testLibraryResolvesTheSessionRepoByPath() async {
        let library = IOSSteerLibrary()
        await library.load(steers: { [self.steer("a", repos: ["shepherd"]), self.steer("b", repos: ["x"])] },
            repos: { ["/w/shepherd": "shepherd"] })
        XCTAssertEqual(IOSSteerScope.barSteers(library.steers, repoName: library.repoNames["/w/shepherd"],
            provider: nil).map(\.id), ["a"])
        XCTAssertNil(library.loadError)
    }

    func testLibraryReportsALoadFailureButKeepsRepos() async {
        struct Boom: Error {}
        let library = IOSSteerLibrary()
        await library.load(steers: { throw Boom() }, repos: { ["/p": "p"] })
        XCTAssertNotNil(library.loadError)
        XCTAssertEqual(library.repoNames, ["/p": "p"])
        XCTAssertTrue(library.loaded)
    }

    func testSwipeCommitsOnlyPastTheThresholdOrOnAFlick() {
        var swipe = IOSSteerSwipe()
        XCTAssertEqual(swipe.update(.changed(-40), allowsBack: true, allowsSteers: true), .none)
        XCTAssertFalse(swipe.armed)
        XCTAssertEqual(swipe.update(.ended(translation: -40, velocity: -100), allowsBack: true, allowsSteers: true), .none)
        XCTAssertEqual(swipe.offset, 0)

        _ = swipe.update(.changed(-95), allowsBack: true, allowsSteers: true)
        XCTAssertTrue(swipe.armed)
        XCTAssertEqual(swipe.update(.ended(translation: -95, velocity: 0), allowsBack: true, allowsSteers: true), .openSteers)
        XCTAssertFalse(swipe.armed)

        XCTAssertEqual(swipe.update(.ended(translation: 40, velocity: 900), allowsBack: true, allowsSteers: true), .back)
        // A flick against the finger's direction is a reversal, not a commit.
        XCTAssertEqual(swipe.update(.ended(translation: 40, velocity: -900), allowsBack: true, allowsSteers: true), .none)
    }

    func testSwipeRespectsDisallowedDirections() {
        var swipe = IOSSteerSwipe()
        _ = swipe.update(.changed(120), allowsBack: false, allowsSteers: true)
        XCTAssertEqual(swipe.offset, 0)
        XCTAssertEqual(swipe.update(.ended(translation: 120, velocity: 0), allowsBack: false, allowsSteers: true), .none)
        XCTAssertEqual(swipe.update(.ended(translation: -120, velocity: 0), allowsBack: true, allowsSteers: false), .none)
    }

    func testSwipeResistsBeyondTheSoftLimit() {
        XCTAssertEqual(IOSSteerSwipe.resisted(100), 100)
        XCTAssertEqual(IOSSteerSwipe.resisted(-240), -(140 + 100 * 0.35), accuracy: 0.001)
    }

    func testSteerSendUsesTheReplyRouteWithoutTouchingTheDraft() async {
        let sent = SentTexts()
        let presentation = IOSTerminalPresentation(session: TerminalSessionModel(sessionID: "fixture", reply: { _ in },
            makeAttachment: { _, _ in fatalError("A steer never needs the PTY") }),
            reply: { text in await sent.append(text) })
        presentation.session.promptText = "my draft"
        let ok = await presentation.sendSteer("Run the tests")
        XCTAssertTrue(ok)
        let texts = await sent.texts
        XCTAssertEqual(texts, ["Run the tests"])
        XCTAssertEqual(presentation.session.promptText, "my draft")
        let blank = await presentation.sendSteer("   ")
        XCTAssertFalse(blank)
    }
}

private actor SentTexts {
    private(set) var texts: [String] = []
    func append(_ text: String) { texts.append(text) }
}
