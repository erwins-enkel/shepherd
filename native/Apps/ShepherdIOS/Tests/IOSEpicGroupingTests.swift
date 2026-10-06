import XCTest
import SwiftUI
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSEpicGroupingTests: XCTestCase {
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
