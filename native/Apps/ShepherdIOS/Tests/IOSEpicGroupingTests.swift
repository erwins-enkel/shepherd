import XCTest
import SwiftUI
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSEpicGroupingTests: XCTestCase {
    func testCuesTallyMemberStagesAndTheFingerprintFollowsMoves() {
        var blocked = session("c", parent: 100, issue: 103)
        blocked.status = .init(known: .blocked)
        let group = IOSMergedSessionPresentation.merge([source(profile("one"),
            active: [session("a", parent: 100, issue: 101), blocked],
            ready: [session("b", parent: 100, issue: 102)])], selectedRepos: []).epicGroups[0]
        XCTAssertEqual(group.stages["b"], .ready)
        XCTAssertEqual(group.cues, IOSEpicCues(ready: 1, blocked: 1))
        XCTAssertFalse(group.cues.isEmpty)
        let moved = IOSMergedSessionPresentation.merge([source(profile("one"),
            active: [session("a", parent: 100, issue: 101), session("b", parent: 100, issue: 102), blocked])],
            selectedRepos: []).epicGroups[0]
        XCTAssertNotEqual(group.fingerprint, moved.fingerprint)
    }

    func testDirectoryKeepsTheFullEpicAndRereadsWhenAMemberMoves() async throws {
        URLProtocol.registerClass(IOSMultiServerFixtureTransport.self)
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let hub = IOSServerHub(launch: launch)
        let profile = try hub.catalogue.addRemoteProfile(name: "Epics", address: "https://epics-full.multi.fixture.invalid")
        try launch.credentials.save(.init(token: "fixture", tokenId: "fixture"), for: profile.credentialKey)
        IOSMultiServerFixtureTransport.set([], for: profile.baseURL)
        await hub.connect(profile)
        defer { hub.disconnect(profile.id) }
        let owner = try XCTUnwrap(hub.models[profile.id])
        try await owner.store?.bootstrap()
        let epic = try JSONDecoder().decode(Epic.self, from: Data(#"""
            {"repoPath":"/repos/app","parentIssueNumber":100,"parentTitle":"Epic: Ship","source":"native",
            "children":[{"number":101,"title":"First","url":"https://x/101","order":0,"body":"","blockedBy":[],
            "state":"running","sessionId":"a","prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":true},
            {"number":102,"title":"Second","url":"https://x/102","order":1,"body":"","blockedBy":[101],
            "state":"blocked","sessionId":null,"prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":false}],
            "warnings":[],"run":{"repoPath":"/repos/app","parentIssueNumber":100,"mode":"auto","status":"running"}}
            """#.utf8))
        var epicReads = 0
        var failEpic = false
        let directory = IOSEpicDirectory(read: { _, _ in .init(epics: [], subIssues: []) }, readEpic: { _, path, parent in
            epicReads += 1
            XCTAssertEqual(path, "/repos/app")
            XCTAssertEqual(parent, 100)
            if failEpic { throw URLError(.notConnectedToInternet) }
            return epic
        })
        let running = IOSMergedSessionPresentation.merge([source(profile,
            active: [session("a", parent: 100, issue: 101)])], selectedRepos: []).epicGroups
        await directory.load(running, owners: hub.models, fallback: owner)
        await directory.load(running, owners: hub.models, fallback: owner)
        XCTAssertEqual(epicReads, 1)
        XCTAssertEqual(try XCTUnwrap(directory.digest(running[0], owner: owner)).chain(101)?.unlocks, [102])
        // The member moves to Ready: the fingerprint changes and the epic is read again.
        let moved = IOSMergedSessionPresentation.merge([source(profile, active: [],
            ready: [session("a", parent: 100, issue: 101)])], selectedRepos: []).epicGroups
        failEpic = true
        await directory.load(moved, owners: hub.models, fallback: owner)
        XCTAssertEqual(epicReads, 2)
        XCTAssertNotNil(directory.digest(moved[0], owner: owner), "a failed re-read keeps the last known epic")
        hub.disconnect(profile.id)
        XCTAssertNil(directory.digest(moved[0], owner: owner))
    }

    func testEpicCopyNamesRunClockAndStage() throws {
        let epic = try JSONDecoder().decode(Epic.self, from: Data(#"""
            {"repoPath":"/repos/app","parentIssueNumber":100,"parentTitle":"Epic: Ship","source":"native",
            "children":[{"number":101,"title":"First","url":"https://x/101","order":0,"body":"","blockedBy":[],
            "state":"running","sessionId":"a","prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":true}],
            "warnings":[],"run":{"repoPath":"/repos/app","parentIssueNumber":100,"mode":"auto","status":"running"},
            "timing":{"startedAt":0,"pausedAt":null,"pausedMs":0,"landingStartedAt":null,"landedAt":null,"agentMs":0,"idleMs":0}}
            """#.utf8))
        XCTAssertEqual(IOSEpicCopy.runChip(epic), L.t("epic_role_leading"))
        XCTAssertEqual(IOSEpicCopy.clock(epic, now: 10_020_000), L.t("native_ios_epic_since", "2h 47m"))
        XCTAssertEqual(IOSEpicCopy.stage(EpicDigest(epic)), L.t("native_ios_epic_stage", "1", "1"))
        XCTAssertNil(IOSEpicCopy.forecast(epic))
    }

    private func profile(_ name: String) -> ServerProfile {
        .init(name: name, baseURL: URL(string: "https://\(name).fixture.invalid")!, mode: .remote, credentialKey: name)
    }
    private func session(_ id: String, parent: Int? = nil, issue: Int? = nil, repo: String = "/repos/app") -> Session {
        var value = PreviewData.session(id: id, desig: "TASK-\(id)", status: .init(known: .running))
        value.repoPath = repo; value.epicParent = parent; value.issueNumber = issue
        return value
    }
    private func source(_ profile: ServerProfile, active: [Session], ready: [Session] = []) -> IOSMergedSessionPresentation.Source {
        .init(profile: profile, groups: [.init(stage: .active, sessions: active), .init(stage: .ready, sessions: ready)],
            sessions: active + ready, rendered: active + ready, git: [:], finished: [], owed: [])
    }
    func testMembersLeaveStagesAndEmptyStagesDisappearWithoutChangingCounts() {
        let a = session("a", parent: 12, issue: 13)
        let b = session("b", parent: 12, issue: 14)
        let normal = session("normal")
        let result = IOSMergedSessionPresentation.merge([source(profile("one"), active: [a, normal], ready: [b])], selectedRepos: [])
        XCTAssertEqual(result.groups.map(\.stage), [.active])
        XCTAssertEqual(result.groups.flatMap(\.rows).map(\.session.id), ["normal"])
        XCTAssertEqual(result.epicGroups.first?.rows.map(\.session.id), ["a", "b"])
        XCTAssertEqual(result.tallies.total, 3)
        XCTAssertEqual(result.chips.first?.count, 3)
        let onlyEpics = IOSMergedSessionPresentation.merge([source(profile("one"), active: [a], ready: [b])], selectedRepos: [])
        XCTAssertTrue(onlyEpics.groups.isEmpty)
        XCTAssertEqual(onlyEpics.epicGroups.count, 1)
    }
    func testParentAndNilMembershipRemainInLifecycleGroups() {
        let parent = session("parent", parent: 12, issue: 12)
        let normal = session("normal", issue: 13)
        // Membership follows epicParent even while issueNumber is unknown.
        let child = session("child", parent: 12)
        let result = IOSMergedSessionPresentation.merge([source(profile("one"), active: [parent, normal, child])], selectedRepos: [])
        XCTAssertEqual(result.groups.flatMap(\.rows).map(\.session.id), ["parent", "normal"])
        XCTAssertEqual(result.epicGroups.first?.rows.map(\.session.id), ["child"])
    }
    func testServersStaySeparateAndGroupsSortByRepoThenParent() {
        let one = profile("one"), two = profile("two")
        let same = session("same", parent: 10, issue: 11)
        let result = IOSMergedSessionPresentation.merge([
            source(one, active: [session("z", parent: 1, repo: "/repos/z"), same,
                session("early", parent: 2, repo: "/different/app")]),
            source(two, active: [same])], selectedRepos: [])
        XCTAssertEqual(result.epicGroups.map(\.repoName), ["app", "app", "app", "z"])
        XCTAssertEqual(result.epicGroups.map(\.parentNumber), [2, 10, 10, 1])
        XCTAssertEqual(Set(result.epicGroups.map(\.id)).count, 4)
        XCTAssertEqual(Set(result.epicGroups.filter { $0.parentNumber == 10 }.map(\.profile.id)), [one.id, two.id])
    }
    func testRepoFilterAppliesToEpicAndLifecycleGroups() {
        let result = IOSMergedSessionPresentation.merge([source(profile("one"), active: [
            session("a", parent: 1, repo: "/repos/a"), session("b", parent: 1, repo: "/repos/b"),
            session("normal-a", repo: "/repos/a"), session("normal-b", repo: "/repos/b")])], selectedRepos: ["/repos/a"])
        XCTAssertEqual(result.epicGroups.flatMap(\.rows).map(\.session.id), ["a"])
        XCTAssertEqual(result.groups.flatMap(\.rows).map(\.session.id), ["normal-a"])
        XCTAssertEqual(result.tallies.total, 2)
        XCTAssertEqual(result.chips.map(\.count), [2, 2])
    }
    func testEpicStringsResolveInBothLocales() throws {
        for locale in ["en", "de"] {
            let bundle = try XCTUnwrap(Bundle(path: CoreResources.bundle.path(forResource: locale, ofType: "lproj")!))
            for key in ["epic_badge", "epic_group_collapse_aria", "epic_group_expand_aria", "upnext_pill_epic"] {
                XCTAssertNotEqual(bundle.localizedString(forKey: key, value: nil, table: nil), key)
            }
        }
    }
    func testDirectoryCachesPerRepoAndRefreshesNewParentsAndPullToRefresh() async throws {
        URLProtocol.registerClass(IOSMultiServerFixtureTransport.self)
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let hub = IOSServerHub(launch: launch)
        let profile = try hub.catalogue.addRemoteProfile(name: "Epics", address: "https://epics.multi.fixture.invalid")
        try launch.credentials.save(.init(token: "fixture", tokenId: "fixture"), for: profile.credentialKey)
        IOSMultiServerFixtureTransport.set([], for: profile.baseURL)
        await hub.connect(profile)
        defer { hub.disconnect(profile.id) }
        let owner = try XCTUnwrap(hub.models[profile.id])
        try await owner.store?.bootstrap()
        var reads = 0
        var fail = false
        let summary = try JSONDecoder().decode(EpicSummary.self, from: Data(#"{"parentIssueNumber":100,"parentTitle":"Epic title","total":5,"merged":2,"status":"idle","source":"github"}"#.utf8))
        let directory = IOSEpicDirectory { _, path in
            reads += 1
            XCTAssertEqual(path, "/repos/app")
            if fail { throw URLError(.notConnectedToInternet) }
            return .init(epics: [summary], subIssues: [])
        }
        let groups = IOSMergedSessionPresentation.merge([source(profile, active: [session("a", parent: 100)])], selectedRepos: []).epicGroups
        await directory.load(groups, owners: hub.models, fallback: owner)
        await directory.load(groups, owners: hub.models, fallback: owner)
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(directory.summary(groups[0], owner: owner)?.parentTitle, "Epic title")
        let more = IOSMergedSessionPresentation.merge([source(profile, active: [session("a", parent: 100), session("b", parent: 200)])], selectedRepos: []).epicGroups
        await directory.load(more, owners: hub.models, fallback: owner)
        XCTAssertEqual(reads, 2)
        XCTAssertNil(directory.summary(more[1], owner: owner))
        fail = true
        await directory.load(more, owners: hub.models, fallback: owner, force: true)
        await directory.load(more, owners: hub.models, fallback: owner)
        XCTAssertEqual(reads, 3)
        XCTAssertEqual(directory.summary(groups[0], owner: owner)?.merged, 2)
        hub.disconnect(profile.id)
        XCTAssertNil(directory.summary(groups[0], owner: owner))
    }

    func testDirectoryLoadsHealthySummaryWhileAnotherServerNeverAnswers() async throws {
        URLProtocol.registerClass(IOSMultiServerFixtureTransport.self)
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let hub = IOSServerHub(launch: launch)
        let run = UUID().uuidString.lowercased()
        let a = try hub.catalogue.addRemoteProfile(name: "Offline", address: "https://epic-a-\(run).multi.fixture.invalid")
        let b = try hub.catalogue.addRemoteProfile(name: "Online", address: "https://epic-b-\(run).multi.fixture.invalid")
        for profile in [a, b] {
            try launch.credentials.save(.init(token: "fixture", tokenId: "fixture"), for: profile.credentialKey)
            await hub.connect(profile)
        }
        defer { hub.disconnect(a.id); hub.disconnect(b.id) }
        let offline = EpicReadGate(), online = EpicReadGate()
        let summary = try JSONDecoder().decode(EpicSummary.self, from: Data(#"{"parentIssueNumber":100,"parentTitle":"Healthy summary","total":1,"merged":0,"status":"idle","source":"github"}"#.utf8))
        let directory = IOSEpicDirectory { client, _ in
            await (client.profile.id == a.id ? offline : online).wait()
            return .init(epics: [summary], subIssues: [])
        }
        let groups = IOSMergedSessionPresentation.merge([
            source(a, active: [session("a", parent: 100)]), source(b, active: [session("b", parent: 100)])], selectedRepos: []).epicGroups
        let owner = try XCTUnwrap(hub.models[b.id])
        let load = Task { await directory.load(groups, owners: hub.models, fallback: owner) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(15))
        while !(offline.waiting && online.waiting), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(offline.waiting && online.waiting, "Both requests must start independently")
        online.release()
        let group = try XCTUnwrap(groups.first { $0.profile.id == b.id })
        while directory.summary(group, owner: owner) == nil, ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertEqual(directory.summary(group, owner: owner)?.parentTitle, "Healthy summary")
        XCTAssertTrue(offline.waiting)
        offline.release()
        await load.value
    }

    func testRenderDarkEpicListSection() async throws {
        let result = IOSMergedSessionPresentation.merge([source(profile("one"), active: [
            session("01", parent: 100, issue: 101), session("02", parent: 200, issue: 201), session("03")])], selectedRepos: [])
        let summary = try JSONDecoder().decode(EpicSummary.self, from: Data(#"{"parentIssueNumber":100,"parentTitle":"Ship epic grouping","total":5,"merged":2,"status":"idle","source":"github"}"#.utf8))
        let content = List {
            ForEach(result.epicGroups) { group in
                IOSEpicGroupHeader(group: group, summary: group.parentNumber == 100 ? summary : nil, collapsed: false, toggle: {})
                ForEach(group.rows) { row in
                    SessionCardView(card: IOSSessionListPresentation.card(row.session, displayed: row.session, now: 0), select: {})
                        .listRowInsets(EdgeInsets(top: 0, leading: 22, bottom: 0, trailing: 10))
                        .listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
                }
            }
            Text(verbatim: "WORKING").sessionFont(label: true, weight: .medium)
                .foregroundStyle(SessionListStyle.blue).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            ForEach(result.groups.flatMap(\.rows)) { row in
                SessionCardView(card: IOSSessionListPresentation.card(row.session, displayed: row.session, now: 0), select: {})
                    .listRowInsets(EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 10))
                    .listRowBackground(SessionListStyle.background).listRowSeparator(.hidden)
            }
        }.listStyle(.plain).scrollContentBackground(.hidden).listRowSpacing(6)
            .environment(\.defaultMinListRowHeight, 0)
            .background(SessionListStyle.background).preferredColorScheme(.dark)
        // Reuse the hosted-render path from IOSMultiServerRenderTests: ImageRenderer
        // can omit UIKit-backed parts of cards when used directly in an isolated test.
        let size = CGSize(width: 390, height: 600)
        let host = UIHostingController(rootView: content.frame(width: size.width, height: size.height).ignoresSafeArea(.container))
        host.safeAreaRegions = []
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.rootViewController = host; window.isHidden = false; host.view.frame = window.bounds
        defer { window.isHidden = true; window.rootViewController = nil }
        func ready(_ view: UIView) -> Bool {
            if let list = view as? UICollectionView { return !list.visibleCells.isEmpty }
            return view.subviews.contains(where: ready)
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(15))
        while !ready(host.view), ContinuousClock.now < deadline {
            host.view.setNeedsLayout(); host.view.layoutIfNeeded()
            await Task.yield()
        }
        XCTAssertTrue(ready(host.view))
        let format = UIGraphicsImageRendererFormat(); format.scale = 2
        var rendered = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            rendered = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }
        XCTAssertTrue(rendered)
        let renderer = ImageRenderer(content: Image(uiImage: image).resizable().frame(width: size.width, height: size.height))
        renderer.scale = 2
        let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos--shepherd-worktrees-shepherd-ios-werden-epics-bestandteil/016688a2-2332-49d9-99c8-b5aeb00996bd/scratchpad/render/")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCTUnwrap(renderer.uiImage?.pngData()).write(to: directory.appendingPathComponent("epic-session-list-dark.png"))
    }
}

@MainActor
private final class EpicReadGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false
    var waiting: Bool { continuation != nil }
    func wait() async {
        guard !released else { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func release() { released = true; continuation?.resume(); continuation = nil }
}
