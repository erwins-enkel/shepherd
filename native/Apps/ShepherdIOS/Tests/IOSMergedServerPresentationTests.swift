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
        XCTAssertEqual(filtered.chips.map(\.name), ["a", "b"])
        XCTAssertEqual(filtered.chips.map(\.count), [2, 1])
        let stale = IOSMergedSessionPresentation.merge([a, b], selectedRepos: ["/gone"])
        XCTAssertTrue(stale.repos.isEmpty); XCTAssertEqual(stale.tallies.total, 3)
    }
    func testSameRepoOnTwoServersIsOneChip() {
        let a = source(profile("studio"), sessions: [session("a", created: 1, repo: "/Users/kai/site")])
        let b = source(profile("laptop"), sessions: [session("b", created: 2, repo: "/home/kai/site"), session("c", created: 3, repo: "/home/kai/app")])
        let merged = IOSMergedSessionPresentation.merge([a, b], selectedRepos: [])
        XCTAssertEqual(merged.chips.map(\.name), ["app", "site"])
        XCTAssertEqual(merged.chips.map(\.count), [1, 2])
        let filtered = IOSMergedSessionPresentation.merge([a, b], selectedRepos: merged.chips[1].paths)
        XCTAssertEqual(filtered.groups.flatMap(\.rows).map(\.session.id), ["a", "b"])
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
                createdAt: at, labels: [], issueRef: .init(number: number, url: "https://fixture.invalid/\(number)", title: "Task"))
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

    func testRecommendedMergeRanksAcrossServersBeforeDisplayCap() {
        let a = profile("studio"), b = profile("laptop")
        func item(_ number: Int, kind: String, at: Int) -> UpNextItem {
            .init(repoPath: "/app", repoSlug: nil, repoLabel: "App", number: number, title: "Task", url: "https://fixture.invalid", kind: .init(unknown: kind), priority: false, createdAt: at, labels: [], issueRef: .init(number: number, url: "https://fixture.invalid", title: "Task"))
        }
        func source(_ profile: ServerProfile, _ items: [UpNextItem]) -> IOSMergedQueuePresentation.Source {
            .init(profile: profile, snapshot: .init(generatedAt: 1, sections: [.init(kind: .init(known: .repo), repoPath: "/app", repoSlug: nil, repoLabel: "App", items: items, totalCount: items.count)], repoCount: 1, fallback: nil, failedRepoCount: 0))
        }
        let sources = [source(a, (1...5).map { item($0, kind: "feature", at: $0) }), source(b, [item(9, kind: "bug", at: 100), item(8, kind: "epic", at: 200), item(7, kind: "bug", at: 50)])]
        for order in [sources, sources.reversed().map { $0 }] {
            let group = IOSMergedQueuePresentation.groups(order, sort: .recommended, repos: []).first!
            XCTAssertEqual(group.rows.prefix(group.cap).map(\.item.number), [8, 7, 9, 1, 2])
            XCTAssertEqual(group.totalCount, 8)
        }
    }

    func testServerStringsResolveInBothLocales() throws {
        for locale in ["en", "de"] {
            let bundle = try XCTUnwrap(Bundle(path: CoreResources.bundle.path(forResource: locale, ofType: "lproj")!))
            for key in ["native_ios_server_hint", "native_ios_server_connected", "native_ios_server_disconnected", "native_ios_server_disconnect", "native_ios_notification_server"] {
                XCTAssertNotEqual(bundle.localizedString(forKey: key, value: nil, table: nil), key)
            }
        }
    }

    // MARK: - Sessions mirrored from connected machines (#2768)

    private func mirrored(_ id: String, machine: String = "mac-id", name: String = "MacBook",
                          repo: String = "/repos/app", connected: Bool = true) -> Session {
        var copy = session(id, created: 5, repo: repo)
        copy.host = SessionHost(instanceId: machine, name: name, platform: InstancePlatform(known: .macos))
        copy.connection = SessionConnection(state: .init(known: connected ? .connected : .disconnected), since: 1)
        return copy
    }
    private func shownIDs(_ merged: IOSMergedSessionPresentation.Snapshot) -> [String] {
        (merged.epicGroups.flatMap(\.rows) + merged.groups.flatMap(\.rows)).map(\.session.id)
    }
    private func mirroredRows(_ merged: IOSMergedSessionPresentation.Snapshot) -> [IOSMergedSessionPresentation.Row] {
        merged.groups.flatMap(\.rows).filter(\.mirrored)
    }

    func testAMacSessionAppearsOnceWhenTheCoordinatorAndTheMacBookAreBothConnected() {
        let linux = profile("coordinator"), mac = profile("macbook")
        var coordinator = source(linux, sessions: [session("l1", created: 10)])
        coordinator.instanceID = "linux-id"
        coordinator.remote = [mirrored("m1")]
        var macbook = source(mac, sessions: [session("m1", created: 20)])
        macbook.instanceID = "mac-id"
        for order in [[coordinator, macbook], [macbook, coordinator]] {
            let merged = IOSMergedSessionPresentation.merge(order, selectedRepos: [])
            XCTAssertEqual(shownIDs(merged).filter { $0 == "m1" }.count, 1)
            // Shown through its owner's own connection, not the coordinator's mirror.
            XCTAssertEqual(merged.groups.flatMap(\.rows).first { $0.session.id == "m1" }?.profile.id, mac.id)
            XCTAssertTrue(mirroredRows(merged).isEmpty)
            XCTAssertEqual(merged.tallies.total, 2)
        }
        // Before the MacBook's /api/instance answers, its own copy still stands in for the mirror.
        macbook.instanceID = nil
        let early = IOSMergedSessionPresentation.merge([coordinator, macbook], selectedRepos: [])
        XCTAssertEqual(shownIDs(early).filter { $0 == "m1" }.count, 1)
        XCTAssertTrue(mirroredRows(early).isEmpty)
    }

    func testTheCoordinatorAloneJoinsTheMacSessionsIntoTheLifecycleGroups() {
        let linux = profile("coordinator")
        var coordinator = source(linux, sessions: [session("l1", created: 10, repo: "/repos/app")])
        coordinator.instanceID = "linux-id"
        coordinator.remote = [mirrored("m1", repo: "/Users/me/app"),
            mirrored("b1", machine: "box-id", name: "Box", connected: false)]
        // The repo filter names this server's checkouts; it never hides another machine's work.
        let merged = IOSMergedSessionPresentation.merge([coordinator], selectedRepos: ["/repos/app"])
        // No group per machine (#3055): interleaved by start time among the server's own.
        XCTAssertEqual(merged.groups.map(\.stage), [.active])
        XCTAssertEqual(merged.groups[0].rows.map(\.session.id), ["m1", "b1", "l1"])
        XCTAssertEqual(merged.groups[0].rows.map(\.mirrored), [true, true, false])
        XCTAssertEqual(mirroredRows(merged).map(\.profile.id), [linux.id, linux.id])
        XCTAssertEqual(merged.tallies.total, 1)
        XCTAssertEqual(merged.chips.map(\.name), ["app"])
        XCTAssertEqual(merged.chips.map(\.paths), [["/repos/app"]])
    }

    func testAMirroredSessionSitsInTheStageItsMachinesPRStateGivesItAndOnlyInTheAllLens() {
        var coordinator = source(profile("coordinator"), sessions: [session("l1", created: 10)])
        coordinator.instanceID = "linux-id"
        var landed = mirrored("m1", connected: false)
        landed.status = .init(known: .done)
        landed.git = GitState(state: .init(known: .merged), checks: .init(known: .success), deployConfigured: false)
        var green = mirrored("m2")
        green.status = .init(known: .idle)
        green.git = GitState(state: .init(known: .open), checks: .init(known: .success), deployConfigured: false)
        coordinator.remote = [landed, green, mirrored("m3")]
        let merged = IOSMergedSessionPresentation.merge([coordinator], selectedRepos: [])
        XCTAssertEqual(merged.groups.map(\.stage), [.active, .awaitingMerge, .merged])
        XCTAssertEqual(merged.groups.map { $0.rows.map(\.session.id) }, [["m3", "l1"], ["m2"], ["m1"]])
        let ready = IOSMergedSessionPresentation.merge([coordinator], selectedRepos: [], lens: .ready)
        XCTAssertTrue(mirroredRows(ready).isEmpty)
    }

    func testOneSessionMirroredByTwoCoordinatorsOrServedUnderTwoProfilesAppearsOnce() {
        var a = source(profile("a"), sessions: [])
        a.instanceID = "a-id"
        a.remote = [mirrored("m1")]
        var b = source(profile("b"), sessions: [])
        b.instanceID = "b-id"
        b.remote = [mirrored("m1")]
        XCTAssertEqual(shownIDs(IOSMergedSessionPresentation.merge([a, b], selectedRepos: [])), ["m1"])

        let first = profile("tailnet"), second = profile("lan")
        var viaTailnet = source(first, sessions: [session("s1", created: 1)])
        viaTailnet.instanceID = "same-id"
        var viaLAN = source(second, sessions: [session("s1", created: 1)])
        viaLAN.instanceID = "same-id"
        let merged = IOSMergedSessionPresentation.merge([viaTailnet, viaLAN], selectedRepos: [])
        XCTAssertEqual(shownIDs(merged), ["s1"])
        XCTAssertEqual(merged.groups.first?.rows.first?.profile.id, first.id)
        XCTAssertEqual(merged.tallies.total, 1)
    }

    // MARK: - The server list names the machines each server mirrors (#3057)

    func testTheCoordinatorListsTheMacBookAsAddedDirectlyWhenBothAreConnected() {
        let linux = profile("coordinator"), mac = profile("macbook")
        var coordinator = source(linux, sessions: [session("l1", created: 10)])
        coordinator.instanceID = "linux-id"
        coordinator.remote = [mirrored("m1"), mirrored("m2"),
            mirrored("b1", machine: "box-id", name: "build-box", connected: false)]
        var macbook = source(mac, sessions: [session("m1", created: 20), session("m2", created: 30)])
        macbook.instanceID = "mac-id"
        for order in [[coordinator, macbook], [macbook, coordinator]] {
            let machines = IOSMergedSessionPresentation.mirroredMachines(order)
            XCTAssertEqual(machines[linux.id]?.map(\.host.name), ["MacBook", "build-box"])
            XCTAssertEqual(machines[linux.id]?.map(\.direct), [true, false])
            XCTAssertEqual(machines[linux.id]?.last?.connection.state.known, .disconnected)
            XCTAssertNil(machines[mac.id])
            let merged = IOSMergedSessionPresentation.merge(order, selectedRepos: [])
            XCTAssertEqual(shownIDs(merged).filter { $0.hasPrefix("m") }, ["m1", "m2"])
            XCTAssertEqual(mirroredRows(merged).map(\.session.host?.instanceId), ["box-id"])
            XCTAssertEqual(mirroredRows(merged).first?.profile.id, linux.id)
        }
        // Before the MacBook's /api/instance answers, its own sessions already mark it direct.
        macbook.instanceID = nil
        XCTAssertEqual(IOSMergedSessionPresentation.mirroredMachines([coordinator, macbook])[linux.id]?.map(\.direct),
            [true, false])
    }

    func testTheCoordinatorAloneListsTheMacBookAsMirroredOnly() {
        let linux = profile("coordinator")
        var coordinator = source(linux, sessions: [session("l1", created: 10)])
        coordinator.instanceID = "linux-id"
        coordinator.remote = [mirrored("m1"), mirrored("m2")]
        let machines = IOSMergedSessionPresentation.mirroredMachines([coordinator])
        XCTAssertEqual(machines[linux.id], [.init(host: mirrored("m1").host!, connection: mirrored("m1").connection!,
            direct: false)])
        let merged = IOSMergedSessionPresentation.merge([coordinator], selectedRepos: [])
        XCTAssertEqual(mirroredRows(merged).map(\.profile.name), ["coordinator", "coordinator"])
        XCTAssertEqual(mirroredRows(merged).map(\.session.id), ["m1", "m2"])
        XCTAssertTrue(IOSMergedSessionPresentation.mirroredMachines([source(linux, sessions: [])]).isEmpty)
    }

    func testAMirroredCardNamesItsMachineAndTheLostLink() {
        let card = IOSSessionListPresentation.card(mirrored("m1", connected: false),
            displayed: mirrored("m1", connected: false), now: 1_800_000_000_000)
        XCTAssertTrue(card.metadata.hasPrefix("MacBook · TASK-m1"))
        XCTAssertEqual(card.badges.first?.id, "machine")
        XCTAssertEqual(card.badges.first?.text, "⚠ MacBook")
        XCTAssertEqual(card.summary, RemoteSessionCopy.disconnectedLine(mirrored("m1", connected: false), now: 1_800_000_000_000))
    }
}
