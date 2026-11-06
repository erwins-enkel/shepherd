import XCTest
import SwiftUI
import UIKit
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSCommandBarTests: XCTestCase {
    private let profile = ServerProfile(name: "Studio", baseURL: URL(string: "https://fixture.invalid")!, mode: .remote, credentialKey: "fixture")
    private func row(_ id: String, name: String, updated: Int = 1, repo: String = "/repos/shepherd", status: SessionStatusKnown = .running) -> IOSMergedSessionPresentation.Row {
        var session = PreviewData.session(id: id, desig: "TASK-\(id)", status: .init(known: status))
        session.name = name; session.repoPath = repo; session.updatedAt = updated
        return .init(profile: profile, session: session)
    }
    private func snapshot(_ rows: [IOSMergedSessionPresentation.Row], epic: [IOSMergedSessionPresentation.Row] = [], finished: [IOSMergedSessionPresentation.Row] = []) -> IOSMergedSessionPresentation.Snapshot {
        .init(epicGroups: epic.isEmpty ? [] : [.init(id: "epic", profile: profile, repoPath: "/repos/shepherd", parentNumber: 42, rows: epic)],
            groups: [.init(stage: .active, rows: rows, heading: nil)], finished: finished, owed: [],
            chips: [.init(name: "shepherd", paths: ["/repos/shepherd", "/other/shepherd"], count: rows.count)],
            repos: [], tallies: .init())
    }
    private func facts(_ rows: [IOSMergedSessionPresentation.Row], needs: Set<String> = []) -> [IOSSessionIdentity: IOSCommandBarPresentation.SessionFacts] {
        Dictionary(uniqueKeysWithValues: rows.map { ($0.id, .init(status: SessionStatusStyle.label($0.session.status), needsYou: needs.contains($0.session.id))) })
    }

    func testFuzzyTiersAndWebScores() throws {
        let exact = try XCTUnwrap(IOSFuzzy.fuzzyScore("shep", "Shep"))
        let prefix = try XCTUnwrap(IOSFuzzy.fuzzyScore("shep", "Shepherd"))
        let substring = try XCTUnwrap(IOSFuzzy.fuzzyScore("shep", "my Shepherd"))
        let fuzzy = try XCTUnwrap(IOSFuzzy.fuzzyScore("shp", "Shepherd"))
        XCTAssertEqual(exact.kind, .exact); XCTAssertEqual(exact.score, 4029)
        XCTAssertEqual(prefix.kind, .prefix); XCTAssertEqual(prefix.score, 3029)
        XCTAssertEqual(substring.kind, .substring); XCTAssertEqual(substring.score, 2029)
        XCTAssertEqual(substring.positions, [3, 4, 5, 6])
        XCTAssertEqual(fuzzy.kind, .fuzzy); XCTAssertEqual(fuzzy.score, 1017)
        XCTAssertEqual(fuzzy.positions, [0, 1, 3]); XCTAssertEqual(fuzzy.span, 4)
        XCTAssertEqual(IOSFuzzy.fuzzyScore("", "anything"), .init(score: 0, positions: [], kind: .empty, span: 0))
        XCTAssertNil(IOSFuzzy.fuzzyScore("missing", "Shepherd"))
    }

    func testFuzzySpanCutoffAndQualityClamp() throws {
        XCTAssertNotNil(IOSFuzzy.fuzzyScore("ab", "a1234b"))
        XCTAssertNil(IOSFuzzy.fuzzyScore("ab", "a12345b"))
        XCTAssertNotNil(IOSFuzzy.fuzzyScore("a", "very long text a"))
        XCTAssertEqual(IOSFuzzy.fuzzyScore(String(repeating: "a", count: 100), String(repeating: "a", count: 100))?.score, 4250)
        // Greedy alignment is deliberately retained, even when a later substring is better.
        XCTAssertNil(IOSFuzzy.fuzzyScore("ab", "a123456789ab"))
    }

    func testFuzzyPositionsUseOriginalCharactersWithUmlautsAndEmoji() {
        XCTAssertEqual(IOSFuzzy.fuzzyScore("är", "🦊 Ärger")?.positions, [2, 3])
        XCTAssertEqual(IOSFuzzy.fuzzyScore("grö", "Größe")?.positions, [0, 1, 2])
        XCTAssertEqual(IOSFuzzy.fuzzyScore("c", "İ cat")?.positions, [2])
        XCTAssertEqual(IOSFuzzy.fuzzyScore("ä", "A\u{0308}pfel")?.positions, [0])
    }

    func testBlankOrderNeedsYouThenRecencyAndNoCommands() {
        let rows = [row("old", name: "Old", updated: 1), row("new", name: "New", updated: 300), row("blocked", name: "Needs input", updated: 2)]
        let groups = IOSCommandBarPresentation.groups(query: "  ", snapshot: snapshot(rows), facts: facts(rows, needs: ["blocked"]), availability: .init(newTask: true))
        XCTAssertEqual(groups.map(\.kind), [.sessions, .repos, .lenses])
        XCTAssertEqual(groups[0].rows.map(\.title), ["Needs input", "New", "Old"])
        XCTAssertEqual(groups.flatMap(\.rows).map(\.index), Array(0..<9))
        XCTAssertEqual(groups[0].rows[0].subtitle, "shepherd · " + SessionStatusStyle.label(rows[2].session.status))
    }

    func testTypedQueryReordersGroupsByBestRank() {
        let rows = [row("1", name: "Shepherd fix")]
        let groups = IOSCommandBarPresentation.groups(query: "shepherd", snapshot: snapshot(rows), facts: facts(rows))
        XCTAssertEqual(groups.map(\.kind), [.repos, .sessions])
        XCTAssertEqual(groups[0].rows[0].positions, Array(0..<8))
        XCTAssertTrue(groups[1].rows[0].positions.isEmpty)
        XCTAssertEqual(groups[1].rows[0].repoPositions, Array(0..<8))
    }

    func testSessionFieldsAreIndependentAndPromptIsOnlySubstringFallback() {
        let original = row("7", name: "Repair", repo: "/repos/engine")
        var session = original.session
        session.prompt = "Explain the regression in the data loader"
        let title = IOSMergedSessionPresentation.Row(profile: profile, session: session)
        let state = snapshot([title]), f = facts([title])
        let desig = IOSCommandBarPresentation.groups(query: "TASK-7", snapshot: state, facts: f).flatMap(\.rows).first!
        XCTAssertEqual(desig.designationPositions, Array(0..<6)); XCTAssertTrue(desig.positions.isEmpty)
        XCTAssertEqual(desig.rank, IOSFuzzy.fuzzyScore("TASK-7", "TASK-7")!.score - 100)
        let repo = IOSCommandBarPresentation.groups(query: "engine", snapshot: state, facts: f).flatMap(\.rows).first!
        XCTAssertEqual(repo.repoPositions, Array(0..<6)); XCTAssertTrue(repo.positions.isEmpty)
        let prompt = IOSCommandBarPresentation.groups(query: "data loader", snapshot: state, facts: f).flatMap(\.rows).first!
        XCTAssertEqual(prompt.rank, 500); XCTAssertTrue(prompt.positions.isEmpty)
        XCTAssertTrue(IOSCommandBarPresentation.groups(query: "regression loader", snapshot: state, facts: f).isEmpty)
        XCTAssertTrue(IOSCommandBarPresentation.groups(query: "repairTASK", snapshot: state, facts: f).isEmpty)
    }

    func testEpicRowsDeduplicateByIdentityAndExcludeFinishedRows() {
        let a = row("1", name: "One"), b = row("2", name: "Two")
        let otherProfile = ServerProfile(name: "Other", baseURL: profile.baseURL, mode: .remote, credentialKey: "other")
        let sameID = IOSMergedSessionPresentation.Row(profile: otherProfile, session: a.session)
        let state = snapshot([a, sameID], epic: [a, b], finished: [row("3", name: "Finished")])
        XCTAssertEqual(IOSCommandBarPresentation.sessions(state).map(\.id), [a.id, sameID.id, b.id])
    }

    func testNextNeedsYouAvailabilityExcludesSelectedAndIsSearchDriven() {
        let rows = [row("1", name: "First"), row("2", name: "Second")]
        let state = snapshot(rows), f = facts(rows, needs: ["1", "2"])
        let availability = IOSCommandBarPresentation.Availability(selected: rows[0].id)
        XCTAssertEqual(IOSCommandBarPresentation.nextNeedsYou(state, facts: f, selected: rows[0].id), rows[1].id)
        let commands = IOSCommandBarPresentation.groups(query: L.t("commandbar_cmd_next_needs_you"), snapshot: state, facts: f, availability: availability).flatMap(\.rows)
        XCTAssertTrue(commands.contains { $0.action == .command(.nextNeedsYou(rows[1].id)) })
        let onlySelected = IOSCommandBarPresentation.groups(query: L.t("commandbar_cmd_next_needs_you"), snapshot: state, facts: facts(rows, needs: ["1"]), availability: availability).flatMap(\.rows)
        XCTAssertFalse(onlySelected.contains { if case .command(.nextNeedsYou) = $0.action { return true }; return false })
    }

    func testCommandKeywordsAndNewTaskGateAndServerCommand() {
        let state = snapshot([])
        let keyword = L.t("commandbar_cmd_new_task_kw").split(separator: " ").first.map(String.init)!
        let available = IOSCommandBarPresentation.groups(query: keyword, snapshot: state, facts: [:], availability: .init(newTask: true)).flatMap(\.rows)
        XCTAssertTrue(available.contains { $0.action == .command(.newTask) })
        let unavailable = IOSCommandBarPresentation.groups(query: keyword, snapshot: state, facts: [:]).flatMap(\.rows)
        XCTAssertFalse(unavailable.contains { $0.action == .command(.newTask) })
        let servers = IOSCommandBarPresentation.groups(query: L.t("native_toolbar_servers"), snapshot: state, facts: [:]).flatMap(\.rows)
        XCTAssertTrue(servers.contains { $0.action == .command(.servers) })
    }

    func testRepoActionSetsAllChipPathsAndLensUsesSharedLabel() {
        let groups = IOSCommandBarPresentation.groups(query: "", snapshot: snapshot([]), facts: [:])
        XCTAssertEqual(groups.first?.rows.first?.action, .repo(["/repos/shepherd", "/other/shepherd"]))
        XCTAssertEqual(groups.last?.rows.map(\.title), HerdLens.allCases.map { L.t($0.labelKey) })
    }

    func testPullThresholds() {
        for value in [-20.0, 0, 8, 63.99] { XCTAssertEqual(IOSPullStage(distance: value), .idle) }
        for value in [64.0, 100, 143.99] { XCTAssertEqual(IOSPullStage(distance: value), .search) }
        for value in [144.0, 200] { XCTAssertEqual(IOSPullStage(distance: value), .reload) }
    }

    func testPullRetainsDragMaximumAndNeverArmsFromBounce() {
        var pull = IOSCommandBarPull()
        pull.update(distance: 200)
        XCTAssertEqual(pull.stage, .idle)
        pull.begin(distance: 0); pull.update(distance: 70); pull.update(distance: 12)
        XCTAssertEqual(pull.release(), .search)
        XCTAssertEqual(pull.stage, .idle); XCTAssertFalse(pull.interacting)
        pull.update(distance: 200); XCTAssertEqual(pull.stage, .idle)
        pull.begin(distance: 0); pull.update(distance: 150); pull.update(distance: 30)
        XCTAssertEqual(pull.release(), .reload)
    }

    func testSheetFixtureSnapshots() async throws {
        let rows = [row("1", name: "Shepherd command bar", updated: 3, status: .blocked),
                    row("2", name: "Ship iOS voice input", updated: 2), row("3", name: "Review plan gates")]
        let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos--shepherd-worktrees-shepherd-coole-command-bar-ios/4cd85f70-4ebb-4543-bf8b-d6e20fbf9340/scratchpad/shots", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for query in ["", "shep"] {
            let sheet = IOSCommandBarSheet(snapshot: snapshot(rows), facts: facts(rows, needs: ["1"]),
                availability: .init(newTask: true), initialQuery: query, activate: { _ in XCTFail("Rendering must not activate rows") })
            let size = CGSize(width: 390, height: 844)
            let host = UIHostingController(rootView: sheet.frame(width: size.width, height: size.height).ignoresSafeArea(.container))
            host.safeAreaRegions = []
            let window = UIWindow(frame: CGRect(origin: .zero, size: size))
            window.rootViewController = host; window.isHidden = false; host.view.frame = window.bounds
            defer { window.isHidden = true; window.rootViewController = nil }
            func ready(_ view: UIView) -> Bool {
                if let scroll = view as? UIScrollView { return scroll.contentSize.height > 0 && scroll.bounds.height > 0 }
                return view.subviews.contains(where: ready)
            }
            let deadline = ContinuousClock.now.advanced(by: .seconds(15))
            while !ready(host.view), ContinuousClock.now < deadline {
                host.view.setNeedsLayout(); host.view.layoutIfNeeded(); await Task.yield()
            }
            XCTAssertTrue(ready(host.view), "Production command scroll content must render")
            let format = UIGraphicsImageRendererFormat(); format.scale = 2
            var rendered = false
            let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                rendered = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
            }
            XCTAssertTrue(rendered)
            let renderer = ImageRenderer(content: Image(uiImage: image).resizable().frame(width: size.width, height: size.height))
            renderer.scale = 2
            try XCTUnwrap(renderer.uiImage?.pngData()).write(to: directory.appendingPathComponent("command-bar-\(query.isEmpty ? "blank" : query).png"))
        }
    }
}
