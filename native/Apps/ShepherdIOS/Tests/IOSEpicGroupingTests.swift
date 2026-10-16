import XCTest
import SwiftUI
import Vision
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

    func testFingerprintFollowsOpeningAndReplacingPRWithoutAStageChange() {
        let profile = profile("pr")
        let member = session("a", parent: 100, issue: 101)
        func group(_ number: Int?) -> IOSMergedSessionPresentation.EpicGroup {
            var git = GitState(state: .init(known: .open), checks: .init(known: .none), deployConfigured: false)
            git.number = number
            return IOSMergedSessionPresentation.merge([.init(profile: profile,
                groups: [.init(stage: .active, sessions: [member])], sessions: [member],
                rendered: [member], git: [member.id: git], finished: [], owed: [])],
                selectedRepos: []).epicGroups[0]
        }
        XCTAssertNotEqual(group(nil).fingerprint, group(112).fingerprint)
        XCTAssertNotEqual(group(112).fingerprint, group(113).fingerprint)
    }

    func testFingerprintIgnoresStatusChangesWhileBlockedCueStaysLive() {
        let profile = profile("status")
        func group(_ status: SessionStatus) -> IOSMergedSessionPresentation.EpicGroup {
            var member = session("a", parent: 100, issue: 101)
            member.status = status
            return IOSMergedSessionPresentation.merge([source(profile, active: [member])],
                selectedRepos: []).epicGroups[0]
        }
        let running = group(.init(known: .running))
        for status in [SessionStatus(known: .idle), .init(unknown: "waiting"), .init(known: .blocked)] {
            let changed = group(status)
            XCTAssertEqual(running.fingerprint, changed.fingerprint)
            XCTAssertEqual(changed.cues.blocked, status.known == .blocked ? 1 : 0)
        }
    }

    func testBlockedCueUsesTheOwningServersRenderedStatus() {
        let profile = profile("working")
        var blocked = session("a", parent: 100)
        blocked.status = .init(known: .blocked)
        var rendered = blocked
        rendered.status = .init(known: .running)
        let group = IOSMergedSessionPresentation.merge([.init(profile: profile,
            groups: [.init(stage: .active, sessions: [blocked])], sessions: [blocked],
            rendered: [rendered], git: [:], finished: [], owed: [])], selectedRepos: []).epicGroups[0]
        XCTAssertEqual(group.cues.blocked, 0)
        XCTAssertEqual(group.rows[0].session.status.known, .blocked)
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
        var failListing = true
        var listingReads = 0
        let directory = IOSEpicDirectory(read: { _, _ in
            listingReads += 1
            if failListing { throw URLError(.badServerResponse) }
            return .init(epics: [], subIssues: [])
        }, readEpic: { _, path, parent in
            epicReads += 1
            XCTAssertEqual(path, "/repos/app")
            XCTAssertEqual(parent, 100)
            if failEpic { throw URLError(.notConnectedToInternet) }
            return epic
        })
        let running = IOSMergedSessionPresentation.merge([source(profile,
            active: [session("a", parent: 100, issue: 101)])], selectedRepos: []).epicGroups
        await directory.load(running, owners: hub.models, fallback: owner)
        XCTAssertEqual(listingReads, 1)
        XCTAssertNotNil(directory.digest(running[0], owner: owner))
        failListing = false
        failEpic = true
        await directory.load(running, owners: hub.models, fallback: owner)
        XCTAssertEqual(epicReads, 2, "A failed listing must retry without a membership change")
        XCTAssertNotNil(directory.digest(running[0], owner: owner), "Keep the last known epic on failure")
        failEpic = false
        await directory.load(running, owners: hub.models, fallback: owner)
        await directory.load(running, owners: hub.models, fallback: owner)
        XCTAssertEqual(epicReads, 3, "Only a completely successful load is cached")
        XCTAssertEqual(try XCTUnwrap(directory.digest(running[0], owner: owner)).chain(101)?.unlocks, [102])
        // The member moves to Ready: the fingerprint changes and the epic is read again.
        let moved = IOSMergedSessionPresentation.merge([source(profile, active: [],
            ready: [session("a", parent: 100, issue: 101)])], selectedRepos: []).epicGroups
        failEpic = true
        await directory.load(moved, owners: hub.models, fallback: owner)
        XCTAssertEqual(epicReads, 4)
        failEpic = false
        await directory.load(moved, owners: hub.models, fallback: owner)
        XCTAssertEqual(epicReads, 5, "A failed detail read must retry the same fingerprint")
        failEpic = true
        await directory.load(moved, owners: hub.models, fallback: owner, force: true)
        failEpic = false
        await directory.load(moved, owners: hub.models, fallback: owner)
        XCTAssertEqual(epicReads, 7, "A failed forced refresh invalidates previous completion")
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

    func testChainStripReadsAsOneSentence() throws {
        let epic = try JSONDecoder().decode(Epic.self, from: Data(#"""
            {"repoPath":"/repos/app","parentIssueNumber":100,"parentTitle":"Epic: Ship","source":"native",
            "children":[
            {"number":101,"title":"A","url":"https://x/101","order":0,"body":"","blockedBy":[],"state":"running","sessionId":"a","prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":true},
            {"number":102,"title":"B","url":"https://x/102","order":1,"body":"","blockedBy":[101],"state":"blocked","sessionId":null,"prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":false},
            {"number":103,"title":"C","url":"https://x/103","order":2,"body":"","blockedBy":[101],"state":"blocked","sessionId":null,"prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":false}],
            "warnings":[],"run":{"repoPath":"/repos/app","parentIssueNumber":100,"mode":"auto","status":"running"}}
            """#.utf8))
        var mixed = epic
        mixed.children[0].state = .init(unknown: "merged")
        mixed.children[2].blockedBy = [101, 102]
        let mixedChain = try XCTUnwrap(EpicDigest(mixed).chain(103))
        XCTAssertEqual(IOSEpicChainStrip.needsText(mixedChain, limit: 2),
            "✓ #101 · " + L.t("native_ios_epic_need_open", "#102"))
        mixed.children[2].blockedBy = [101, 102, 104]
        var fourth = mixed.children[1]
        fourth.number = 104
        mixed.children.append(fourth)
        XCTAssertEqual(IOSEpicChainStrip.needsText(try XCTUnwrap(EpicDigest(mixed).chain(103)), limit: 2),
            "✓ #101 · " + L.t("native_ios_epic_need_open", "#102") + " +1")
        let chain = try XCTUnwrap(EpicDigest(epic).chain(101))
        XCTAssertEqual(IOSEpicChainStrip.accessibilityText(chain), L.t("native_ios_epic_chain_aria",
            L.t("native_ios_epic_needs_none"), "1", "2", "101",
            "#102, #103, " + L.t("native_ios_epic_parallel", "2")))
    }

    func testSheetMatchesSessionIDThenIssueEvenWhenIDIsStale() throws {
        var child = try JSONDecoder().decode(EpicChild.self, from: Data(#"""
            {"number":101,"title":"A","url":"https://x/101","order":0,"body":"","blockedBy":[],
            "state":"running","sessionId":"a","prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":true}
            """#.utf8))
        let group = IOSMergedSessionPresentation.merge([source(profile("match"), active: [
            session("replacement", parent: 100, issue: 101), session("a", parent: 100, issue: 999)])],
            selectedRepos: []).epicGroups[0]
        XCTAssertEqual(group.row(for: child)?.session.id, "a", "session ID has precedence")
        child.sessionId = "stale"
        XCTAssertEqual(group.row(for: child)?.session.id, "replacement", "a stale ID falls back to the issue")
        child.sessionId = nil
        XCTAssertEqual(group.row(for: child)?.session.id, "replacement")
        child.number = 888
        XCTAssertNil(group.row(for: child))
        let selection = IOSEpicSelection(id: group.id)
        let current = IOSMergedSessionPresentation.merge([source(group.profile, active: [
            session("new", parent: 100, issue: 888), session("latest", parent: 100, issue: 101)])],
            selectedRepos: []).epicGroups
        XCTAssertEqual(selection.resolve(in: current)?.row(for: child)?.session.id, "new")
        child.number = 101
        XCTAssertEqual(selection.resolve(in: current)?.row(for: child)?.session.id, "latest")
        XCTAssertNil(selection.resolve(in: []))
    }

    func testChildStateCopyDistinguishesReadyWaitingMergedAndActive() throws {
        var child = try JSONDecoder().decode(EpicChild.self, from: Data(#"""
            {"number":101,"title":"A","url":"https://x/101","order":0,"body":"","blockedBy":[],
            "state":"ready","sessionId":null,"prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":false}
            """#.utf8))
        let states: [(String, StaticString)] = [("ready", "epicflow_legend_ready"), ("blocked", "epicflow_legend_waiting"),
            ("merged", "epicflow_legend_merged"), ("running", "epic_state_running"),
            ("in-review", "epic_state_in_review")]
        for (state, key) in states {
            child.state = .init(unknown: state)
            XCTAssertEqual(IOSEpicCopy.state(child), L.t(key))
        }
    }

    func testCollapsedHeaderAnnouncesFullTitleAndEveryCue() throws {
        var blocked = session("blocked", parent: 100)
        blocked.status = .init(known: .blocked)
        var group = IOSMergedSessionPresentation.merge([source(profile("cues"), active: [
            session("ci", parent: 100), session("rework", parent: 100),
            session("merge", parent: 100), blocked], ready: [session("ready", parent: 100)])],
            selectedRepos: []).epicGroups[0]
        group.stages["ci"] = .ciFailed
        group.stages["rework"] = .needsRework
        group.stages["merge"] = .branchProtectionBlocked
        let summary = try JSONDecoder().decode(EpicSummary.self, from: Data(#"{"parentIssueNumber":100,"parentTitle":"Epic: Ship","total":5,"merged":0,"status":"idle","source":"github"}"#.utf8))
        let header = IOSEpicGroupHeader(group: group, summary: summary, collapsed: true, toggle: {})
        let expected = [summary.parentTitle, L.t("epic_group_cue_ci_failed", "1"),
            L.t("epic_group_cue_changes_requested", "1"), L.t("epic_group_cue_merge_blocked", "1"),
            L.t("epic_group_cue_ready", "1"), L.t("epic_group_cue_blocked", "1")]
        for text in expected {
            XCTAssertTrue(header.accessibilityValue.contains(text), "Missing announcement: \(text)")
        }
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
            for key in ["epic_badge", "epic_group_collapse_aria", "epic_group_expand_aria", "upnext_pill_epic",
                        "epic_role_leading", "epic_group_cue_ready", "epicflow_title", "epicflow_merged",
                        "childrun_step_unlocks", "native_ios_epic_needs", "native_ios_epic_stage",
                        "native_ios_epic_more_steps", "native_ios_epic_fold_next_after", "native_ios_epic_open_aria",
                        "native_ios_epic_chain_aria", "native_ios_epic_slots_hint", "native_ios_epic_open_web"] {
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
        let epic = try JSONDecoder().decode(Epic.self, from: Data(#"""
            {"repoPath":"/repos/app","parentIssueNumber":100,"parentTitle":"Epic title","source":"native",
            "children":[],"warnings":[],"run":{"repoPath":"/repos/app","parentIssueNumber":100,"mode":"auto","status":"running"}}
            """#.utf8))
        let directory = IOSEpicDirectory(read: { _, path in
            reads += 1
            XCTAssertEqual(path, "/repos/app")
            if fail { throw URLError(.notConnectedToInternet) }
            return .init(epics: [summary], subIssues: [])
        }, readEpic: { _, _, parent in
            var copy = epic
            copy.parentIssueNumber = parent
            return copy
        })
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
        XCTAssertEqual(reads, 4, "Failed refreshes remain retryable without force")
        fail = false
        await directory.load(more, owners: hub.models, fallback: owner)
        await directory.load(more, owners: hub.models, fallback: owner)
        XCTAssertEqual(reads, 5)
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

    func testDirectoryPublishesBeforeSlowDetailsAndCancelsWithItsCaller() async throws {
        URLProtocol.registerClass(IOSMultiServerFixtureTransport.self)
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let hub = IOSServerHub(launch: launch)
        let profile = try hub.catalogue.addRemoteProfile(name: "Progressive", address: "https://epic-progress.multi.fixture.invalid")
        try launch.credentials.save(.init(token: "fixture", tokenId: "fixture"), for: profile.credentialKey)
        IOSMultiServerFixtureTransport.set([], for: profile.baseURL)
        await hub.connect(profile)
        defer { hub.disconnect(profile.id) }
        let owner = try XCTUnwrap(hub.models[profile.id])
        try await owner.store?.bootstrap()
        let summary = try JSONDecoder().decode(EpicSummary.self, from: Data(#"{"parentIssueNumber":100,"parentTitle":"Available now","total":1,"merged":0,"status":"idle","source":"github"}"#.utf8))
        let epic = try JSONDecoder().decode(Epic.self, from: Data(#"""
            {"repoPath":"/repos/app","parentIssueNumber":100,"parentTitle":"Available now","source":"native",
            "children":[],"warnings":[],"run":{"repoPath":"/repos/app","parentIssueNumber":100,"mode":"auto","status":"running"}}
            """#.utf8))
        let slow = EpicReadGate()
        var reads: [Int] = []
        var cancelled = false
        let directory = IOSEpicDirectory(read: { _, _ in .init(epics: [summary], subIssues: []) },
            readEpic: { _, _, parent in
                reads.append(parent)
                if parent == 200 && reads.count == 2 {
                    await slow.wait()
                    cancelled = Task.isCancelled
                }
                return epic
            })
        let groups = IOSMergedSessionPresentation.merge([source(profile, active: [
            session("a", parent: 100), session("b", parent: 200), session("c", parent: 300)])],
            selectedRepos: []).epicGroups
        let load = Task { await directory.load(groups, owners: hub.models, fallback: owner) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(15))
        while !slow.waiting, ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(slow.waiting)
        XCTAssertEqual(directory.summary(groups[0], owner: owner)?.parentTitle, "Available now")
        XCTAssertNotNil(directory.digest(groups[0], owner: owner))
        load.cancel()
        slow.release()
        await load.value
        XCTAssertTrue(cancelled, "Cancellation must reach an in-flight detail request")
        XCTAssertEqual(reads, [100, 200], "Cancellation must prevent subsequent requests")
        XCTAssertNotNil(directory.digest(groups[0], owner: owner), "Keep already published data")

        await directory.load(groups, owners: hub.models, fallback: owner)
        await directory.load(groups, owners: hub.models, fallback: owner)
        XCTAssertEqual(reads, [100, 200, 100, 200, 300], "A cancelled first load retries without force")

        // A newer load also cancels the old request, even if the caller has not cancelled it.
        let gate = EpicReadGate()
        var first = true
        var superseded = false
        var details = 0
        let replacement = IOSEpicDirectory(read: { _, _ in
            if first {
                first = false
                await gate.wait()
                superseded = Task.isCancelled
            }
            return .init(epics: [summary], subIssues: [])
        }, readEpic: { _, _, _ in details += 1; return epic })
        let old = Task { await replacement.load(groups, owners: hub.models, fallback: owner) }
        while !gate.waiting, ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(gate.waiting)
        await replacement.load([], owners: hub.models, fallback: owner)
        gate.release()
        await old.value
        XCTAssertTrue(superseded)
        XCTAssertEqual(details, 0)
        await replacement.load(groups, owners: hub.models, fallback: owner)
        XCTAssertEqual(details, 3, "A superseded first load retries without force")

        // Cancelling a forced refresh must also invalidate an already cached fingerprint.
        let refreshGate = EpicReadGate()
        var pause = false
        var refreshReads = 0
        let refreshable = IOSEpicDirectory(read: { _, _ in
            refreshReads += 1
            if pause { await refreshGate.wait() }
            return .init(epics: [summary], subIssues: [])
        }, readEpic: { _, _, _ in epic })
        await refreshable.load(groups, owners: hub.models, fallback: owner)
        pause = true
        let refresh = Task { await refreshable.load(groups, owners: hub.models, fallback: owner, force: true) }
        let refreshDeadline = ContinuousClock.now.advanced(by: .seconds(15))
        while !refreshGate.waiting, ContinuousClock.now < refreshDeadline { await Task.yield() }
        XCTAssertTrue(refreshGate.waiting)
        refresh.cancel()
        refreshGate.release()
        await refresh.value
        XCTAssertNotNil(refreshable.digest(groups[0], owner: owner))
        pause = false
        await refreshable.load(groups, owners: hub.models, fallback: owner)
        await refreshable.load(groups, owners: hub.models, fallback: owner)
        XCTAssertEqual(refreshReads, 3, "A cancelled forced refresh retries without force")
    }

    func testRenderDarkEpicListSection() async throws {
        let result = IOSMergedSessionPresentation.merge([source(profile("one"), active: [
            session("01", parent: 100, issue: 101), session("02", parent: 200, issue: 201), session("03")])], selectedRepos: [])
        let summary = try JSONDecoder().decode(EpicSummary.self, from: Data(#"{"parentIssueNumber":100,"parentTitle":"Ship epic grouping","total":5,"merged":2,"status":"idle","source":"github"}"#.utf8))
        let epic = try JSONDecoder().decode(Epic.self, from: Data(#"""
            {"repoPath":"/repos/app","parentIssueNumber":100,"parentTitle":"Epic: Ship epic grouping","source":"native",
            "children":[
            {"number":101,"title":"First","url":"https://x/101","order":0,"body":"","blockedBy":[],"state":"running","sessionId":"01","prNumber":112,"issueClosed":false,"integrationMerged":false,"claimed":true},
            {"number":102,"title":"Second","url":"https://x/102","order":1,"body":"","blockedBy":[101],"state":"blocked","sessionId":null,"prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":false},
            {"number":103,"title":"Third","url":"https://x/103","order":2,"body":"","blockedBy":[101],"state":"blocked","sessionId":null,"prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":false}],
            "warnings":[],"run":{"repoPath":"/repos/app","parentIssueNumber":100,"mode":"auto","status":"running"}}
            """#.utf8))
        let digest = EpicDigest(epic)
        let content = List {
            ForEach(result.epicGroups) { group in
                IOSEpicGroupHeader(group: group, summary: group.parentNumber == 100 ? summary : nil,
                    digest: group.parentNumber == 100 ? digest : nil, collapsed: false, toggle: {}, open: {})
                ForEach(group.rows) { row in
                    SessionCardView(card: IOSSessionListPresentation.card(row.session, displayed: row.session, now: 0),
                        chain: group.parentNumber == 100 ? digest.chain(101) : nil, select: {})
                        .listRowInsets(EdgeInsets(top: 0, leading: 22, bottom: 0, trailing: 10))
                        .listRowBackground(IOSEpicRailBackground()).listRowSeparator(.hidden)
                }
                if group.parentNumber == 100 {
                    IOSEpicFoldRow(fold: digest.fold(shown: [101]), parent: 100, expanded: true, toggle: {}, open: {})
                        .listRowInsets(EdgeInsets(top: 0, leading: 22, bottom: 0, trailing: 10))
                        .listRowBackground(IOSEpicRailBackground()).listRowSeparator(.hidden)
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
        let size = CGSize(width: 390, height: 844)
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
        // Check rendered text, not accessibility copy: a compressed column can still
        // be announced by VoiceOver while being completely invisible on screen.
        let textRequest = VNRecognizeTextRequest()
        textRequest.recognitionLevel = .accurate
        textRequest.recognitionLanguages = ["en-US", "de-DE"]
        try VNImageRequestHandler(cgImage: XCTUnwrap(image.cgImage)).perform([textRequest])
        let visibleText = (textRequest.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: " ").uppercased()
        XCTAssertTrue(visibleText.contains(L.t("native_ios_epic_needs").uppercased()),
            "The needs column must remain visible at iPhone width: \(visibleText)")
        XCTAssertTrue(visibleText.contains(L.t("native_ios_epic_more_steps", "2").uppercased()),
            "The folded-step count must remain readable at iPhone width: \(visibleText)")
        let renderer = ImageRenderer(content: Image(uiImage: image).resizable().frame(width: size.width, height: size.height))
        renderer.scale = 2
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("render")
        print("epic render: \(directory.appendingPathComponent("epic-session-list-dark.png").path)")
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
