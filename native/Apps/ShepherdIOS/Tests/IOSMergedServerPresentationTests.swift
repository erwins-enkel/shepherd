import XCTest
import SwiftUI
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSMergedServerPresentationTests: XCTestCase {
    private func profile(_ name: String) -> ServerProfile {
        ServerProfile(name: name, baseURL: URL(string: "https://\(name).fixture.invalid")!, mode: .remote, credentialKey: name)
    }
    private func session(_ id: String, created: Int, repo: String = "/repos/app", status: SessionStatusKnown = .running) -> Session {
        var session = PreviewData.session(id: id, desig: "TASK-\(id)", status: .init(known: status))
        session.createdAt = created; session.repoPath = repo
        return session
    }
    private func source(_ profile: ServerProfile, sessions: [Session], stages: [String: HerdStage] = [:], git: [String: GitState] = [:], finished: [Session] = [], owed: [PostMergeSteps] = []) -> IOSMergedSessionPresentation.Source {
        let sidebar = SidebarModel(reads: .stub, now: { 1_800_000_000_000 })
        sidebar.install(sessions: sessions)
        sidebar.gitStage = { stages[$0.id] }
        return .init(profile: profile, groups: sidebar.groups, sessions: sessions,
            rendered: sessions.map(sidebar.rendered), git: git, finished: finished, owed: owed)
    }
    func testStageOrderAndChronologicalMergePreserveCollidingIDs() {
        let a = profile("studio"), b = profile("laptop")
        let sources = [source(a, sessions: [session("same", created: 10), session("a", created: 30), session("merge", created: 1, status: .done)], stages: ["merge": .merged]),
            source(b, sessions: [session("b", created: 20), session("same", created: 40), session("ci", created: 2, status: .done)], stages: ["ci": .ciRunning])]
        let merged = IOSMergedSessionPresentation.merge(sources, selectedRepos: [])
        XCTAssertEqual(merged.groups.map(\.stage), [.active, .ciRunning, .merged])
        XCTAssertEqual(merged.groups[0].rows.map(\.session.id), ["same", "b", "a", "same"])
        XCTAssertEqual(Set(merged.groups[0].rows.map(\.id)).count, 4)
        XCTAssertEqual(merged.groups[0].rows.last?.profile.id, b.id)
        XCTAssertEqual(merged.tallies.total, 6); XCTAssertEqual(merged.tallies.active, 4)
        XCTAssertEqual(merged.tallies.idle, 0)
        XCTAssertEqual(merged.groups[1].heading, L.t("herd_ci_running_group", "1"))
    }
    func testSingleServerKeepsExactCoreOrderAndHintIsConditional() {
        let a = profile("studio")
        let original = source(a, sessions: [session("new", created: 30), session("old", created: 10)])
        XCTAssertEqual(IOSMergedSessionPresentation.merge([original], selectedRepos: []).groups.first?.rows.map(\.session.id), ["new", "old"])
        XCTAssertNil(IOSMergedSessionPresentation.serverHint(a, connectedCount: 1))
        XCTAssertEqual(IOSMergedSessionPresentation.serverHint(a, connectedCount: 2), "studio")
        let card = IOSSessionListPresentation.card(original.sessions[0], displayed: original.sessions[0], now: 100)
        XCTAssertNil(SessionCardView(card: card, select: {}).serverName)
        XCTAssertEqual(SessionCardView(card: card, serverName: IOSMergedSessionPresentation.serverHint(a, connectedCount: 2), select: {}).serverName, "studio")
    }
    func testGlobalRepoFilterDoesNotBecomeUnfilteredOnOtherServer() {
        let a = source(profile("studio"), sessions: [session("a", created: 1, repo: "/repos/a")])
        let b = source(profile("laptop"), sessions: [session("b", created: 2, repo: "/repos/b"), session("c", created: 3, repo: "/repos/a", status: .idle)])
        let filtered = IOSMergedSessionPresentation.merge([a, b], selectedRepos: ["/repos/a"])
        XCTAssertEqual(filtered.groups.flatMap(\.rows).map(\.session.id), ["a", "c"])
        XCTAssertEqual(filtered.tallies.total, 2); XCTAssertEqual(filtered.tallies.idle, 1)
        XCTAssertEqual(filtered.chips.map(\.path), ["/repos/a", "/repos/b"])
        XCTAssertEqual(filtered.chips.map(\.count), [2, 1])
        let stale = IOSMergedSessionPresentation.merge([a, b], selectedRepos: ["/gone"])
        XCTAssertTrue(stale.repos.isEmpty); XCTAssertEqual(stale.tallies.total, 3)
    }
    func testFinishedAndOwedMergeUseTheirExistingSortKeys() {
        let a = profile("studio"), b = profile("laptop")
        var old = session("same", created: 10, status: .archived); old.archivedAt = 100
        var newer = old; newer.archivedAt = 200
        let owed = PostMergeSteps(sessionId: "same", desig: "TASK-1", repoPath: "/repos/app", prNumber: 1, prTitle: "Example", steps: [], trackingIssueUrl: nil, trackingIssueNumber: nil, createdAt: 100, updatedAt: 100, clearedAt: nil)
        var latest = owed; latest.createdAt = 200
        var cleared = owed; cleared.sessionId = "cleared"; cleared.clearedAt = 300
        let merged = IOSMergedSessionPresentation.merge([source(a, sessions: [], finished: [old], owed: [owed, cleared]), source(b, sessions: [], finished: [newer], owed: [latest])], selectedRepos: [])
        XCTAssertEqual(merged.finished.map(\.profile.id), [b.id, a.id])
        XCTAssertEqual(Set(merged.finished.map(\.id)).count, 2)
        XCTAssertEqual(merged.owed.map(\.profile.id), [b.id, a.id])
        XCTAssertEqual(Set(merged.owed.map(\.id)).count, 2)
    }
    func testHandoffNamesStayScopedWhenSessionIDsCollide() throws {
        let a = profile("studio"), b = profile("laptop")
        func git(_ who: String) throws -> GitState {
            try JSONDecoder().decode(GitState.self, from: Data("""
            {"state":"open","checks":"success","deployConfigured":false,"handoffWho":"\(who)"}
            """.utf8))
        }
        let raw = session("same", created: 1, status: .done)
        let merged = IOSMergedSessionPresentation.merge([source(a, sessions: [raw], stages: ["same": .waitingOnReviewer], git: ["same": try git("Alice")]), source(b, sessions: [raw], stages: ["same": .waitingOnReviewer], git: ["same": try git("Bob")])], selectedRepos: [])
        XCTAssertEqual(merged.groups.first?.heading, L.t("herd_waiting_reviewer_group_multi", "2"))
    }
    func testUpNextSortAndRepoFilterMergeDuplicateIssueIdentities() {
        let a = profile("studio"), b = profile("laptop")
        func item(_ number: Int, at: Int, repo: String = "/a", priority: Bool = false) -> UpNextItem {
            .init(repoPath: repo, repoSlug: nil, repoLabel: repo, number: number, title: "Task \(number)",
                url: "https://fixture.invalid/\(number)", kind: .init(known: .feature), priority: priority,
                createdAt: at, labels: [], issueRef: .init(number: number, url: "https://fixture.invalid/\(number)", title: "Task", body: ""))
        }
        func snapshot(_ items: [UpNextItem]) -> UpNextSnapshot {
            .init(generatedAt: 1, sections: [.init(kind: .init(known: .repo), repoPath: "/a", repoSlug: nil, repoLabel: "A", items: items, totalCount: items.count)], repoCount: 1, fallback: nil, failedRepoCount: 0)
        }
        let sources: [IOSMergedQueuePresentation.Source] = [.init(profile: a, snapshot: snapshot([item(1, at: 10), item(2, at: 30)])),
            .init(profile: b, snapshot: snapshot([item(1, at: 20), item(3, at: 40, repo: "/b")]))]
        let newest = IOSMergedQueuePresentation.groups(sources, sort: .newest, repos: [])
        XCTAssertEqual(newest.flatMap(\.rows).map(\.item.createdAt), [40, 30, 20, 10])
        XCTAssertEqual(Set(newest.flatMap(\.rows).map(\.id)).count, 4)
        let oldest = IOSMergedQueuePresentation.groups(sources, sort: .oldest, repos: [])
        XCTAssertEqual(oldest.flatMap(\.rows).map(\.item.createdAt), [10, 20, 30, 40])
        let filter = IOSMergedQueuePresentation.groups(sources, sort: .newest, repos: ["/b"])
        // Recommended repo sections are filtered by section path, just like core.
        XCTAssertTrue(filter.isEmpty)
        let recommended = IOSMergedQueuePresentation.groups(sources, sort: .recommended, repos: [])
        XCTAssertEqual(recommended.count, 1)
        XCTAssertEqual(recommended.first?.totalCount, 4)
    }

    func testServerStringsResolveInBothLocales() throws {
        for locale in ["en", "de"] {
            let bundle = try XCTUnwrap(Bundle(path: CoreResources.bundle.path(forResource: locale, ofType: "lproj")!))
            for key in ["native_ios_server_hint", "native_ios_server_connected", "native_ios_server_disconnected", "native_ios_server_disconnect", "native_ios_notification_server"] {
                XCTAssertNotEqual(bundle.localizedString(forKey: key, value: nil, table: nil), key)
            }
        }
    }
}
