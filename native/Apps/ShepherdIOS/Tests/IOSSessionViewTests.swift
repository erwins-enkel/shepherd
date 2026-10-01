import XCTest
import SwiftUI
@testable import ShepherdAppCore
import ShepherdKit
@testable import ShepherdIOS

@MainActor
final class IOSSessionViewTests: XCTestCase {
    func testPhoneMovesLiveLensesAndReposToBottomAndPanelLensesToMenu() {
        for sizeClass: UserInterfaceSizeClass? in [.compact, nil] {
            let layout = IOSSessionListLayout(sizeClass: sizeClass)
            XCTAssertTrue(layout.bottomBar)
            XCTAssertFalse(layout.repoRail)
            XCTAssertEqual(layout.stripLenses, [.next, .all, .ready])
            XCTAssertEqual(layout.menuLenses, [.done, .owed])
            XCTAssertEqual(Set(layout.stripLenses + layout.menuLenses), Set(HerdLens.allCases))
        }
    }

    func testTouchWideRetainsAllTopLensesAndResizeKeepsPanelSelectionAndRepoFilter() {
        let wide = IOSSessionListLayout(sizeClass: .regular)
        XCTAssertFalse(wide.bottomBar)
        XCTAssertTrue(wide.repoRail)
        XCTAssertEqual(wide.stripLenses, HerdLens.allCases)
        XCTAssertTrue(wide.menuLenses.isEmpty)
        let sidebar = SidebarModel(reads: .stub, now: { 1_800_000_000_000 })
        sidebar.lens = .owed
        sidebar.install(sessions: [PreviewData.session()])
        let repo = sidebar.chips.first!.path
        sidebar.toggleRepo(repo, additive: false)
        let phone = IOSSessionListLayout(sizeClass: .compact)
        XCTAssertTrue(phone.menuLenses.contains(sidebar.lens))
        XCTAssertTrue(wide.stripLenses.contains(sidebar.lens))
        XCTAssertEqual(sidebar.lens, .owed)
        XCTAssertEqual(sidebar.activeRepos, [repo])
    }

    func testActivityStatesAndServerOrdering() {
        XCTAssertEqual(ActivityView.phase(for: .loading), .loading)
        XCTAssertEqual(ActivityView.phase(for: .failed("offline")), .failed("offline"))
        XCTAssertEqual(ActivityView.phase(for: .ready([])), .empty(L.t("activity_empty")))
        let entry = ActivityEntry(ts: 1, tool: "Read", summary: "a", status: .init(known: .ok))
        XCTAssertEqual(ActivityView.phase(for: .ready([entry])), .content)
    }
    func testDetailIdentityChangesBetweenModels() {
        let first = DetailModel(loaders: .stubbed())
        let second = DetailModel(loaders: .stubbed())
        XCTAssertNotEqual(DetailTaskKey(session: "same", model: first), DetailTaskKey(session: "same", model: second))
        XCTAssertEqual(SessionStatusStyle.label(.init(unknown: "future")), "FUTURE")
    }
    func testFailedForegroundActivityRetriesOnLiveRecovery() async {
        var reads = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in
            reads += 1
            if reads == 1 { throw ShepherdError.unauthenticated }
            return []
        }
        let detail = DetailModel(loaders: loaders)
        let recovery = IOSVisibleActivityRecovery(detail: detail, selectedID: { "s1" }, isCurrent: { true })
        await recovery.reloadVisibleActivityIfNeeded()
        XCTAssertNotNil(detail.activity["s1"]?.failure)
        await recovery.reloadVisibleActivityIfNeeded()
        XCTAssertEqual(detail.activity["s1"], .ready([]))
        XCTAssertEqual(reads, 2)
    }
    func testSupersededActivationCannotRecover() async {
        var reads = 0
        var loaders = DetailModel.Loaders.stubbed()
        loaders.activity = { _ in reads += 1; return [] }
        let detail = DetailModel(loaders: loaders)
        let recovery = IOSVisibleActivityRecovery(detail: detail, selectedID: { "s1" }, isCurrent: { false })
        await recovery.reloadVisibleActivityIfNeeded()
        XCTAssertEqual(reads, 0)
    }

}
