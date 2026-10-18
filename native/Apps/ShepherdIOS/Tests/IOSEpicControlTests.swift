import XCTest
import SwiftUI
import Vision
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSEpicControlTests: XCTestCase {
    func testActionsFollowRunStatusModeAndReadyChildren() throws {
        var epic = try fixture()
        XCTAssertEqual(IOSEpicPolicy.actions(epic), [.pause, .approve])
        epic.run.mode = .init(value1: .auto)
        XCTAssertEqual(IOSEpicPolicy.actions(epic), [.pause])
        epic.run.mode = .init(value1: .attended)
        epic.children.removeAll(where: \.isReady)
        XCTAssertEqual(IOSEpicPolicy.actions(epic), [.pause])
        epic.run.status = .init(unknown: "paused")
        XCTAssertEqual(IOSEpicPolicy.actions(epic), [.resume])
        epic.run.status = .init(unknown: "idle")
        XCTAssertEqual(IOSEpicPolicy.actions(epic), [])
        epic.run.status = .init(unknown: "future")
        XCTAssertEqual(IOSEpicPolicy.actions(epic), [])
    }
    func testChildStartEligibilityAndIssueAttachment() throws {
        let epic = try fixture()
        for child in epic.children {
            XCTAssertEqual(IOSEpicPolicy.canStart(child), [188, 190, 192].contains(child.number))
        }
        var ready = try XCTUnwrap(epic.children.first { $0.number == 188 })
        ready.sessionId = "existing"
        XCTAssertFalse(IOSEpicPolicy.canStart(ready))
        let issue = IOSEpicPolicy.issue(ready)
        XCTAssertEqual(issue.number, ready.number)
        XCTAssertEqual(issue.title, ready.title)
        XCTAssertEqual(issue.body, ready.body)
        XCTAssertEqual(issue.url, ready.url)
        XCTAssertEqual(issue.blockedBy, ready.blockedBy)
    }
    func testParentAndPRLinksReplaceOnlyTheIssuePath() throws {
        var epic = try fixture()
        XCTAssertEqual(IOSEpicPolicy.parentURL(epic)?.absoluteString, "https://github.com/team/calendar/issues/193")
        let active = try XCTUnwrap(epic.children.first { $0.number == 191 })
        XCTAssertEqual(IOSEpicPolicy.prURL(active)?.absoluteString, "https://github.com/team/calendar/pull/211")
        XCTAssertNil(IOSEpicPolicy.prURL(epic.children[0]))
        for url in ["", "https://github.com/team/calendar", "https://github.com/team/calendar/pull/1", "javascript:alert(1)", "/issues/1", "https://github.com/team/calendar/issues/no"] {
            XCTAssertNil(IOSEpicPolicy.issueURL(url, kind: "issues", number: 193))
        }
        XCTAssertEqual(IOSEpicPolicy.issueURL("https://github.com/team/calendar/issues/188?x=1#body", kind: "pull", number: 211)?.absoluteString, "https://github.com/team/calendar/pull/211")
        epic.children = []
        XCTAssertNil(IOSEpicPolicy.parentURL(epic))
    }
    func testSettingsBuildStartAndStatusPreservingPatches() throws {
        let epic = try fixture()
        var settings = IOSEpicSettings(epic.run)
        settings.ignoreUsageCeiling = true
        let start = settings.patch(start: true, running: false)
        XCTAssertEqual(start.status, .running)
        XCTAssertEqual(start.mode, .attended)
        XCTAssertEqual(start.agentProvider, .claude)
        XCTAssertEqual(start.model, "opus")
        XCTAssertEqual(start.effort, "high")
        XCTAssertEqual(start.ignoreUsageCeiling, true)
        XCTAssertNil(settings.patch(start: false, running: true).status)
        XCTAssertEqual(settings.patch(start: false, running: false).ignoreUsageCeiling, false)
        settings.provider = .codex
        settings.normalize(fableAvailable: false)
        XCTAssertEqual(settings.model, "default")
        settings.model = "gpt-6-sol"; settings.effort = "ultra"
        settings.normalize(fableAvailable: false)
        XCTAssertEqual(settings.effort, "ultra")
        settings.model = "gpt-5.5"
        settings.normalize(fableAvailable: false)
        XCTAssertEqual(settings.effort, "default")
    }
    func testStartChecksLeaderAndRequiresAnExplicitRequeueChoice() async throws {
        let (hub, owner, group) = try await context()
        defer { hub.disconnect(group.profile.id) }
        let selection = IOSEpicSelection(group: group)
        XCTAssertNil(selection.resolve(in: []))
        XCTAssertEqual(selection.fallback?.id, group.id, "Detail remains available after the last session leaves")
        let directory = IOSEpicDirectory()
        let epic = try fixture()
        var writes: [Bool] = []
        let control = IOSEpicControl(group: group, owner: owner, directory: directory,
            readLeader: { _, path in XCTAssertEqual(path, group.repoPath); return 42 },
            write: { _, _, _, patch, requeue in
                XCTAssertEqual(patch.status, .running); writes.append(requeue); return epic
            })
        await control.update(.init(status: .running))
        XCTAssertEqual(control.leader, 42)
        XCTAssertTrue(writes.isEmpty)
        control.cancelStart()
        XCTAssertTrue(writes.isEmpty)
        await control.update(.init(status: .running))
        control.confirm(requeue: true)
        // The UI dismisses its dialog immediately; it must not erase the captured write.
        control.cancelStart()
        await until { writes.count == 1 && !control.busy }
        XCTAssertEqual(writes, [true])
        XCTAssertEqual(directory.digest(group, owner: owner)?.epic, epic)
    }
    func testLoadFailureIsVisibleAndSettingsDoNotCheckOrSupersedeLeader() async throws {
        let (hub, owner, group) = try await context()
        defer { hub.disconnect(group.profile.id) }
        let directory = IOSEpicDirectory(readEpic: { _, _, _ in throw URLError(.notConnectedToInternet) })
        var checks = 0
        var epic = try fixture()
        epic.run.mode = .init(value1: .auto)
        let returned = epic
        let control = IOSEpicControl(group: group, owner: owner, directory: directory,
            readLeader: { _, _ in checks += 1; throw URLError(.notConnectedToInternet) },
            write: { _, _, _, patch, _ in XCTAssertNil(patch.status); return returned })
        await control.load()
        XCTAssertNotNil(control.error)
        XCTAssertNil(control.digest)
        await control.update(.init(status: .running))
        XCTAssertNotNil(control.error)
        XCTAssertEqual(checks, 1)
        await control.update(.init(mode: .auto))
        XCTAssertNil(control.error)
        XCTAssertEqual(checks, 1)
        XCTAssertEqual(control.digest?.epic.run.mode.iosValue, "auto")
    }
    func testBusyRequestsAndOldActivationCannotOverwriteTheDirectory() async throws {
        let (hub, owner, group) = try await context()
        defer { hub.disconnect(group.profile.id) }
        let directory = IOSEpicDirectory()
        let epic = try fixture()
        var continuation: CheckedContinuation<Epic, Error>?
        var writes = 0
        let control = IOSEpicControl(group: group, owner: owner, directory: directory,
            write: { _, _, _, _, _ in
                writes += 1
                return try await withCheckedThrowingContinuation { continuation = $0 }
            })
        let request = Task { await control.update(.init(status: .paused)) }
        await until { continuation != nil }
        XCTAssertTrue(control.busy)
        await control.update(.init(mode: .auto))
        XCTAssertEqual(writes, 1)
        hub.disconnect(group.profile.id)
        continuation?.resume(returning: epic)
        await request.value
        XCTAssertFalse(control.current)
        XCTAssertNil(directory.digest(group, owner: owner))
    }
    func testMutationWinsOverAnOlderDetailReadAndApprovalRefreshesTheHeader() async throws {
        let (hub, owner, group) = try await context()
        defer { hub.disconnect(group.profile.id) }
        var old = try fixture(); old.run.status = .init(unknown: "paused")
        let previous = old, updated = try fixture()
        var continuation: CheckedContinuation<Epic, Error>?
        let directory = IOSEpicDirectory(readEpic: { _, _, _ in
            try await withCheckedThrowingContinuation { continuation = $0 }
        })
        let read = Task { try await directory.loadDetail(group, owner: owner) }
        await until { continuation != nil }
        directory.accept(updated, group: group, owner: owner)
        continuation?.resume(returning: previous)
        try await read.value
        XCTAssertEqual(directory.digest(group, owner: owner)?.epic, updated)
        // An update to another parent must not strand this detail's first/refresh read.
        continuation = nil
        let secondRead = Task { try await directory.loadDetail(group, owner: owner) }
        await until { continuation != nil }
        var otherSession = group.rows[0].session
        otherSession.epicParent = 194; otherSession.issueNumber = 195
        let otherGroup = IOSMergedSessionPresentation.merge([.init(profile: group.profile,
            groups: [.init(stage: .active, sessions: [otherSession])], sessions: [otherSession],
            rendered: [otherSession], git: [:], finished: [], owed: [])], selectedRepos: []).epicGroups[0]
        var otherEpic = updated
        otherEpic.parentIssueNumber = 194; otherEpic.run.parentIssueNumber = 194
        directory.accept(otherEpic, group: otherGroup, owner: owner)
        continuation?.resume(returning: previous)
        try await secondRead.value
        XCTAssertEqual(directory.digest(group, owner: owner)?.epic, previous)
        directory.accept(updated, group: group, owner: owner)
        var next = updated
        next.children[1].state = .init(unknown: "running")
        let approved = next
        var calls = 0
        let control = IOSEpicControl(group: group, owner: owner, directory: directory,
            approveNext: { _, _, _ in calls += 1; return approved })
        await control.approve()
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(control.digest?.epic, approved)
        await control.approve()
        XCTAssertEqual(calls, 1, "No ready child remains")
    }
    func testWriteFailuresKeepTheGraphAndReadOnlyLaunchesRejectWrites() async throws {
        let (hub, owner, group) = try await context()
        defer { hub.disconnect(group.profile.id) }
        let directory = IOSEpicDirectory(), epic = try fixture()
        directory.accept(epic, group: group, owner: owner)
        var writes = 0
        let control = IOSEpicControl(group: group, owner: owner, directory: directory,
            write: { _, _, _, _, _ in writes += 1; throw ShepherdError.conflict(code: nil, message: "another epic leads") },
            approveNext: { _, _, _ in writes += 1; throw URLError(.notConnectedToInternet) })
        await control.perform(.pause)
        XCTAssertTrue(control.error?.contains("another epic leads") == true)
        XCTAssertEqual(control.digest?.epic, epic)
        XCTAssertFalse(control.busy)
        await control.approve()
        XCTAssertNotNil(control.error)
        XCTAssertEqual(control.digest?.epic, epic)
        XCTAssertEqual(writes, 2)
        owner.liveRequestAudit = ReadOnlyRequestAudit()
        XCTAssertFalse(control.writable)
        await control.perform(.pause)
        await control.approve()
        XCTAssertEqual(writes, 2)
    }
    func testComposerUsesTheOwningRepoAndPickedChild() async throws {
        let (hub, owner, group) = try await context()
        defer { hub.disconnect(group.profile.id) }
        let store = try XCTUnwrap(owner.store)
        let model = ComposeModel(client: store.client, defaults: owner.composerDefaults)
        let child = try fixture().children[1]
        model.repoPath = group.repoPath
        model.pickIssue(IOSEpicPolicy.issue(child))
        XCTAssertEqual(model.repoPath, "/repos/calendar")
        XCTAssertEqual(model.activeIssue?.number, 188)
        XCTAssertTrue(model.prompt.contains("188"))
        XCTAssertTrue(model.prompt.contains(child.title))
    }
    func testRenderFourDarkEpicScreens() async throws {
        let (hub, owner, group) = try await context()
        defer { hub.disconnect(group.profile.id) }
        let epic = try fixture(), digest = EpicDigest(epic)
        let directory = IOSEpicDirectory(readEpic: { _, _, _ in epic })
        directory.accept(epic, group: group, owner: owner)
        let control = directory.control(group, owner: owner)
        let child = epic.children[1]
        let now = 13_920_000
        let main = VStack(alignment: .leading, spacing: 16) {
            Text(verbatim: "SHEPHERD").sessionFont(weight: .semibold).padding(12)
            IOSEpicGroupHeader(group: group, summary: nil, digest: digest, collapsed: false,
                now: now, toggle: {}, open: {}, control: control).padding(.horizontal, 10)
            SessionCardView(card: IOSSessionListPresentation.card(group.rows[0].session,
                displayed: group.rows[0].session, now: now), chain: digest.chain(189), select: {}).padding(.horizontal, 12)
            IOSEpicFoldRow(fold: digest.fold(shown: [189, 191]), parent: 193, expanded: true, toggle: {}, open: {}).padding(12)
            Spacer()
        }.background(SessionListStyle.background)
        try await render(main, name: "epic-herd-dark", contains: [L.t("epic_pause"), "193"])
        try await render(IOSEpicSheet(control: control, now: now, session: { _ in nil }, created: { _ in }),
            name: "epic-detail-dark", contains: [L.t("epic_pause"), L.t("native_ios_epic_attended")], height: 1500)
        try await render(IOSEpicChildSheet(control: control, digest: digest, child: child, session: nil, created: { _ in }),
            name: "epic-child-dark", contains: [L.t("native_ios_epic_start_child"), "188"])
        var idle = epic; idle.run.status = .init(unknown: "idle")
        try await render(IOSEpicSettingsSheet(control: control, epic: idle), name: "epic-start-dark",
            contains: [L.t("native_ios_epic_start"), L.t("native_ios_epic_ignore_ceiling"), L.t("epic_provider_label"), L.t("epic_model_label"), L.t("epic_effort_label")])
    }

    private func until(_ condition: () -> Bool) async {
        let deadline = ContinuousClock.now.advanced(by: .seconds(15))
        while !condition(), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(condition())
    }
    private func context() async throws -> (IOSServerHub, AppModel, IOSMergedSessionPresentation.EpicGroup) {
        URLProtocol.registerClass(IOSMultiServerFixtureTransport.self)
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let hub = IOSServerHub(launch: launch)
        let profile = try hub.catalogue.addRemoteProfile(name: "Epic controls", address: "https://epic-controls.multi.fixture.invalid")
        try launch.credentials.save(.init(token: "fixture", tokenId: "fixture"), for: profile.credentialKey)
        IOSMultiServerFixtureTransport.set([], for: profile.baseURL)
        await hub.connect(profile)
        let owner = try XCTUnwrap(hub.models[profile.id])
        try await owner.store?.bootstrap()
        // These tests inject every mutation; production isolated launches keep their audit.
        owner.liveRequestAudit = nil
        var row = PreviewData.session(id: "189", desig: "TASK-189", status: .init(known: .running))
        row.repoPath = "/repos/calendar"; row.epicParent = 193; row.issueNumber = 189
        let group = IOSMergedSessionPresentation.merge([.init(profile: profile,
            groups: [.init(stage: .active, sessions: [row])], sessions: [row], rendered: [row],
            git: [:], finished: [], owed: [])], selectedRepos: []).epicGroups[0]
        return (hub, owner, group)
    }
    private func fixture() throws -> Epic {
        let titles = ["Mehrsprachigkeit 1: Sprachmodell", "Mehrsprachigkeit 2: Übersetzungen", "Mehrsprachigkeit 3: Verwaltung und Gastgeber", "Mehrsprachigkeit 5: Integrationen — WordPress", "Mehrsprachigkeit 4: Benachrichtigungen", "Mehrsprachigkeit 6: Kalender veröffentlichen"]
        let numbers = [187, 188, 189, 191, 190, 192], states = ["merged", "ready", "running", "in-review", "blocked", "blocked"]
        let children: [[String: Any]] = numbers.enumerated().map { i, number in
            ["number": number, "title": titles[i], "url": "https://github.com/team/calendar/issues/\(number)",
             "order": i, "body": "Übersetze den Kalender in die EU-Sprachen.\n\nDie bestehenden Texte und das Sprachmodell wiederverwenden.",
             "blockedBy": number == 190 ? [188, 189] : number == 192 ? [190, 191] : [],
             "state": states[i], "sessionId": number == 189 || number == 191 ? String(number) : NSNull(),
             "prNumber": number == 191 ? 211 : NSNull(), "issueClosed": i == 0,
             "integrationMerged": false, "claimed": number == 189 || number == 191]
        }
        let data = try JSONSerialization.data(withJSONObject: ["repoPath": "/repos/calendar", "parentIssueNumber": 193,
            "parentTitle": "Epic: Mehrsprachigkeit — Calendar in EU-Sprachen", "source": "native", "children": children, "warnings": [],
            "run": ["repoPath": "/repos/calendar", "parentIssueNumber": 193, "mode": "attended", "status": "running", "agentProvider": "claude", "model": "opus", "effort": "high"],
            "timing": ["startedAt": 0, "pausedAt": NSNull(), "pausedMs": 0, "landingStartedAt": NSNull(), "landedAt": NSNull(), "agentMs": 0, "idleMs": 0]])
        return try JSONDecoder().decode(Epic.self, from: data)
    }
    private func render<V: View>(_ view: V, name: String, contains words: [String], height: CGFloat = 844) async throws {
        let size = CGSize(width: 390, height: height)
        let content = view.preferredColorScheme(.dark).environment(\.locale, Locale(identifier: "de"))
            .frame(width: size.width, height: size.height).ignoresSafeArea(.container)
        let host = UIHostingController(rootView: content)
        host.safeAreaRegions = []
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.rootViewController = host; window.isHidden = false; host.view.frame = window.bounds
        defer { window.isHidden = true; window.rootViewController = nil }
        var image: UIImage?
        let deadline = ContinuousClock.now.advanced(by: .seconds(15))
        var text = ""
        while ContinuousClock.now < deadline {
            host.view.setNeedsLayout(); host.view.layoutIfNeeded()
            await Task.yield()
            let format = UIGraphicsImageRendererFormat(); format.scale = 2
            image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
            }
            let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate
            request.recognitionLanguages = ["en-US", "de-DE"]
            try VNImageRequestHandler(cgImage: XCTUnwrap(image?.cgImage)).perform([request])
            text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
            if words.allSatisfy({ text.localizedCaseInsensitiveContains($0) }) { break }
        }
        for word in words { XCTAssertTrue(text.localizedCaseInsensitiveContains(word), "\(name): missing \(word) in \(text)") }
        let renderer = ImageRenderer(content: Image(uiImage: try XCTUnwrap(image)).resizable().frame(width: size.width, height: size.height))
        renderer.scale = 2
        let output = ProcessInfo.processInfo.environment["SHEPHERD_EPIC_RENDER_DIR"]
            ?? NSTemporaryDirectory() + "/epic-controls-render"
        let directory = URL(fileURLWithPath: output)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCTUnwrap(renderer.uiImage?.pngData()).write(to: directory.appendingPathComponent(name + ".png"))
    }
}
