import XCTest
import SwiftUI
import UIKit
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

/// PRs in Up Next on iOS: the swipe and sheet merge both go through the confirmation, a refused
/// takeover re-arms it with the gate, fix/review/train start sessions like the composer, and the
/// list, sheet and confirmation render from fixtures (PNGs land in the scratchpad for review).
@MainActor
final class IOSUpNextPrTests: XCTestCase {
    private let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos--shepherd-worktrees-shepherd-setze-prs-naechstes-ios/9f802b76-0464-4632-b7e3-cb17c991c892/scratchpad/ios-upnext-prs/")

    @MainActor final class Fake {
        var merges: [(pr: UpNextPr, method: MergeMethod?, deleteBranch: Bool, confirm: MergeConfirmation?)] = []
        var mergeFailures: [any Error] = []
        var rebases: [Int] = []
        var creates: [CreateSessionRequest] = []
        var created = PreviewData.session(id: "fix-1", desig: "TASK-09")
        var hold = false
        var defaultBranch: String? = "trunk"
        var branchReads: [String] = []
        var writable = true
        var refreshes = 0
        lazy var controller = IOSUpNextPrController(commands: commands, canWrite: { self.writable },
                                                    refreshQueue: { self.refreshes += 1 })
        var commands: IOSUpNextPrCommands {
            .init(merge: { pr, method, delete, confirm in
                self.merges.append((pr, method, delete, confirm))
                if !self.mergeFailures.isEmpty { throw self.mergeFailures.removeFirst() }
            }, dependabotRebase: { self.rebases.append($0.number) },
               createSession: { request in
                self.creates.append(request)
                return self.hold ? .held(.init(held: true, id: "h1", count: 1)) : .created(self.created)
            }, defaultBranch: { repo in self.branchReads.append(repo); return self.defaultBranch })
        }
    }

    private func pr(_ number: Int, band: UpNextPr.Band, action: UpNextPr.Action?, block: UpNextPr.BlockReason? = nil,
                    checks: UpNextPr.Checks = .success, kind: UpNextPr.Kind = .regular, repo: String = "/r/manufare-website",
                    title: String = "Sicherheits-Check 2026-10-22: 2 Fixes", base: String? = "main", age: Int = 1) -> UpNextPr {
        UpNextPr(repoPath: repo, repoSlug: "o/\(DonePresentation.repoBasename(repo))", repoLabel: DonePresentation.repoBasename(repo),
                 number: number, title: title, url: "https://github.com/o/\(DonePresentation.repoBasename(repo))/pull/\(number)",
                 author: "kai-osthoff", kind: kind, createdAt: Int(Date().timeIntervalSince1970 * 1_000) - age * 3_600_000,
                 checks: checks, mergeable: block == .conflict ? false : true, baseRefName: base, mergeMethod: "squash",
                 closesIssue: number == 985 ? .init(number: 972, url: "https://github.com/o/manufare-website/issues/972") : nil,
                 band: band, action: action, blockReason: block)
    }

    func testSwipeOffersMergeOnlyForTheMergeActionAndOpensTheConfirmation() {
        XCTAssertTrue(IOSUpNextPrSwipe.offersMerge(pr(1, band: .ready, action: .merge)))
        XCTAssertFalse(IOSUpNextPrSwipe.offersMerge(pr(2, band: .review, action: .review)))
        XCTAssertFalse(IOSUpNextPrSwipe.offersMerge(pr(3, band: .blocked, action: .fix, block: .conflict)))
        let fake = Fake()
        fake.controller.prepareMerge(pr(1, band: .ready, action: .merge))
        XCTAssertEqual(fake.controller.mergeDraft?.pr.number, 1)
        XCTAssertTrue(fake.merges.isEmpty, "opening the confirmation never merges")
        // Blocked PRs cannot even open it; a read-only activation neither.
        fake.controller.dismissMerge()
        fake.controller.prepareMerge(pr(3, band: .blocked, action: .fix, block: .conflict))
        XCTAssertNil(fake.controller.mergeDraft)
        fake.writable = false
        fake.controller.prepareMerge(pr(1, band: .ready, action: .merge))
        XCTAssertNil(fake.controller.mergeDraft)
    }

    func testMergeConfirmationArmsAfterTheDelayAndEchoesARefusedGate() async {
        let fake = Fake()
        let controller = fake.controller
        let ready = pr(911, band: .ready, action: .merge)
        controller.prepareMerge(ready)
        let presented = controller.mergeDraft?.presentedAt ?? Date()
        XCTAssertFalse(controller.canConfirmMerge(now: presented.addingTimeInterval(0.1)))
        XCTAssertTrue(controller.canConfirmMerge(now: presented.addingTimeInterval(0.4)))
        controller.setMergeMethod(.rebase); controller.setDeleteBranch(false)

        // First attempt: the server names a responsible reviewer; the sheet re-arms with the gate.
        let gate = MergeResponsibility(handoff: .init(known: .reviewer), handoffWho: "pat")
        fake.mergeFailures = [BacklogMergeRefusal(code: .required, message: "someone else's", gate: gate, headSha: "abc", baseRefName: "main")]
        var merged = await controller.confirmMerge(now: presented.addingTimeInterval(0.4))
        XCTAssertFalse(merged)
        XCTAssertEqual(fake.merges.count, 1)
        XCTAssertNil(fake.merges.first?.confirm)
        XCTAssertEqual(fake.merges.first?.method, .rebase)
        XCTAssertEqual(fake.merges.first?.deleteBranch, false)
        XCTAssertEqual(controller.mergeDraft?.refusal?.gate?.handoffWho, "pat")
        XCTAssertTrue(controller.mergeDraft?.isTakeover == true)
        XCTAssertEqual(controller.mergeDraft?.confirmTitle, L.t("mergeconfirm_confirm_takeover"))
        XCTAssertEqual(controller.error, "someone else's")
        let rearmed = controller.mergeDraft?.presentedAt ?? .distantPast
        XCTAssertFalse(controller.canConfirmMerge(now: rearmed))
        XCTAssertTrue(controller.canConfirmMerge(now: rearmed.addingTimeInterval(0.4)))

        // Second attempt echoes exactly what was shown.
        merged = await controller.confirmMerge(now: rearmed.addingTimeInterval(0.4))
        XCTAssertTrue(merged)
        XCTAssertEqual(fake.merges.count, 2)
        XCTAssertEqual(fake.merges.last?.confirm?.handoffWho, "pat")
        XCTAssertEqual(fake.merges.last?.confirm?.headSha, "abc")
        XCTAssertEqual(fake.merges.last?.confirm?.handoff, .reviewer)
        XCTAssertNil(controller.mergeDraft)
        XCTAssertEqual(controller.note?.text, L.t("prbadge_merged_toast", "911"))
        XCTAssertEqual(fake.refreshes, 1)

        // Any other failure shows the copy and re-arms the sheet for a retry.
        controller.clearFeedback()
        controller.prepareMerge(ready)
        fake.mergeFailures = [ShepherdError.conflict(code: nil, message: "base busy")]
        merged = await controller.confirmMerge(now: (controller.mergeDraft?.presentedAt ?? Date()).addingTimeInterval(1))
        XCTAssertFalse(merged)
        XCTAssertNil(controller.mergeDraft?.refusal)
        XCTAssertNotNil(controller.error)
        let retry = try! XCTUnwrap(controller.mergeDraft?.presentedAt)
        XCTAssertFalse(controller.canConfirmMerge(now: retry))
        XCTAssertTrue(controller.canConfirmMerge(now: retry.addingTimeInterval(0.4)))
    }

    func testFixAndReviewSessionsUseThePrBaseOrTheRepoDefaultAndSelectTheSession() async {
        let fake = Fake()
        var selected: [String] = []
        let blocked = pr(985, band: .blocked, action: .fix, block: .conflict, title: "feat(mcp): Werkstattbericht")
        var ok = await fake.controller.startSession(.fix, blocked) { selected.append($0) }
        XCTAssertTrue(ok)
        XCTAssertEqual(fake.creates.count, 1)
        XCTAssertEqual(fake.creates.first?.baseBranch, "main")
        XCTAssertTrue(fake.creates.first?.prompt.contains("#985") == true)
        XCTAssertEqual(fake.creates.first?.planGateEnabled, false)
        XCTAssertTrue(fake.branchReads.isEmpty, "a PR with a base branch needs no lookup")
        XCTAssertEqual(selected, ["fix-1"])
        XCTAssertEqual(fake.controller.note?.text, L.t("native_ios_upnext_pr_started", "TASK-09"))

        // No base from the server: the repo default, then "main".
        ok = await fake.controller.startSession(.review, pr(5, band: .review, action: .review, base: nil)) { selected.append($0) }
        XCTAssertTrue(ok)
        XCTAssertEqual(fake.creates.last?.baseBranch, "trunk")
        XCTAssertEqual(fake.branchReads, ["/r/manufare-website"])
        fake.defaultBranch = nil
        _ = await fake.controller.startSession(.review, pr(6, band: .review, action: .review, base: nil)) { selected.append($0) }
        XCTAssertEqual(fake.creates.last?.baseBranch, "main")

        // Held behind the usage reset: a warning, nothing selected.
        fake.hold = true
        ok = await fake.controller.startSession(.fix, blocked) { selected.append($0) }
        XCTAssertTrue(ok)
        XCTAssertEqual(selected.count, 3)
        XCTAssertEqual(fake.controller.note?.tone, .warning)

        fake.writable = false
        ok = await fake.controller.startSession(.fix, blocked) { selected.append($0) }
        XCTAssertFalse(ok)
        XCTAssertEqual(fake.creates.count, 4)

        // Writes revoked while the default branch is being looked up: nothing is posted.
        let revoking = Fake()
        revoking.hold = false
        var lookups = 0
        let revokingController = IOSUpNextPrController(commands: .init(
            merge: { _, _, _, _ in }, dependabotRebase: { _ in },
            createSession: { request in revoking.creates.append(request); return .created(revoking.created) },
            defaultBranch: { _ in lookups += 1; revoking.writable = false; return "trunk" }), canWrite: { revoking.writable })
        ok = await revokingController.startSession(.review, pr(7, band: .review, action: .review, base: nil)) { selected.append($0) }
        XCTAssertFalse(ok)
        XCTAssertEqual(lookups, 1)
        XCTAssertTrue(revoking.creates.isEmpty)
    }

    func testTrainPlansPerServerSoSharedRepoPathsNeverMix() throws {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let studio = launch.makeModel(persistsProfileCatalogue: false)
        let laptop = launch.makeModel(persistsProfileCatalogue: false)
        let rows = [
            IOSUpNextPrRow(pr: pr(1, band: .dependabot, action: .merge, kind: .dependabot, repo: "/r/web"), app: studio, serverName: "studio"),
            IOSUpNextPrRow(pr: pr(2, band: .dependabot, action: .merge, kind: .dependabot, repo: "/r/web"), app: laptop, serverName: "laptop"),
            IOSUpNextPrRow(pr: pr(3, band: .dependabot, action: .merge, kind: .dependabot, repo: "/r/web"), app: laptop, serverName: "laptop"),
            IOSUpNextPrRow(pr: pr(4, band: .dependabot, action: .merge, kind: .dependabot, repo: "/r/api"), app: studio, serverName: "studio"),
        ]
        let (plan, owner) = try XCTUnwrap(IOSUpNextPrSection.trainPlan(rows))
        XCTAssertTrue(owner.app === laptop)
        XCTAssertEqual(plan.prs.map(\.number), [2, 3])
        XCTAssertEqual(plan.otherRepoCount, 2)
        XCTAssertNil(IOSUpNextPrSection.trainPlan([rows[0]].map { row in
            IOSUpNextPrRow(pr: pr(9, band: .dependabot, action: nil, checks: .pending, kind: .dependabot), app: row.app, serverName: nil)
        }))
    }

    func testTrainAndRebaseGoToTheServer() async {
        let fake = Fake()
        let bots = [
            pr(21, band: .dependabot, action: .merge, kind: .dependabot, title: "bump a"),
            pr(22, band: .dependabot, action: .merge, kind: .dependabot, title: "bump b"),
            pr(23, band: .dependabot, action: .dependabotRebase, block: .behind, kind: .dependabot, title: "bump c"),
        ]
        let plan = try! XCTUnwrap(UpNextPrPresentation.trainPlan(bots))
        var selected: [String] = []
        let ok = await fake.controller.startTrain(plan) { selected.append($0) }
        XCTAssertTrue(ok)
        XCTAssertEqual(fake.creates.first?.mergeTrainPrs, [21, 22])
        XCTAssertEqual(fake.creates.first?.autopilotEnabled, false)
        XCTAssertEqual(selected, ["fix-1"])

        let rebased = await fake.controller.requestRebase(bots[2])
        XCTAssertTrue(rebased)
        XCTAssertEqual(fake.rebases, [23])
        XCTAssertEqual(fake.controller.note?.text, L.t("native_ios_upnext_pr_rebase_requested", "23"))
    }

    func testBadgeAndToolbarCopy() {
        XCTAssertEqual(IOSUpNextToolbar.filterTitle(0), L.t("native_ios_upnext_pr_toolbar_filter_none"))
        XCTAssertEqual(IOSUpNextToolbar.filterTitle(1), L.t("native_ios_upnext_pr_toolbar_filter_one"))
        XCTAssertEqual(IOSUpNextToolbar.filterTitle(2), L.t("native_ios_upnext_pr_toolbar_filter", "2"))
        let badge = L.t("native_ios_upnext_pr_badge_aria", L.t("herd_seg_next"), "2")
        XCTAssertTrue(badge.hasPrefix(L.t("herd_seg_next") + ", 2 "), badge)
        XCTAssertEqual(IOSUpNextPrGroupTitle.tint(.review), SessionListStyle.violet)
        XCTAssertEqual(IOSUpNextPrGroupTitle.tint(.blocked), SessionListStyle.warn)
    }

    func testRendersListSheetAndConfirmationFixtures() async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel(persistsProfileCatalogue: false)
        let fake = Fake()
        let prs = [
            pr(911, band: .ready, action: .merge, age: 2),
            pr(865, band: .ready, action: .merge, title: "Sicherheits-Check 2026-10-18: 1 Fix", age: 30),
            pr(990, band: .review, action: .review, title: "feat(ui): Repos-Dialog V2", age: 5),
            pr(985, band: .blocked, action: .fix, block: .conflict, title: "feat(mcp): Werkstattbericht, Videos und Videozugänge über Claude bedienen (#972)", age: 2),
            pr(968, band: .blocked, action: .fix, block: .conflict, checks: .failure, title: "chore(eemockup): pakete aktualisieren", age: 40),
            pr(21, band: .dependabot, action: .merge, kind: .dependabot, title: "build(deps): bump astro"),
            pr(22, band: .dependabot, action: .merge, kind: .dependabot, title: "build(deps): bump vite"),
            pr(23, band: .dependabot, action: .merge, kind: .dependabot, title: "build(deps-dev): bump vitest"),
            pr(24, band: .dependabot, action: .merge, kind: .dependabot, title: "build(deps): bump sharp"),
        ]
        let rows = prs.map { IOSUpNextPrRow(pr: $0, app: app, serverName: nil, fixtureController: fake.controller) }
        let list = List {
            IOSUpNextPrSection(rows: rows, sort: .newest, repos: [], select: { _, _ in })
        }
        .listStyle(.plain).scrollContentBackground(.hidden).listRowSpacing(6)
        .environment(\.defaultMinListRowHeight, 0)
        .foregroundStyle(SessionListStyle.ink).background(SessionListStyle.background)
        .environment(app).preferredColorScheme(.dark)
        try await save(list, name: "upnext-pr-list", listed: true)

        let sheet = NavigationStack {
            IOSUpNextPrSheetContent(row: rows[3], select: { _, _ in }, finished: {})
                .navigationTitle(L.t("native_ios_upnext_pr_sheet_title", "985")).navigationBarTitleDisplayMode(.inline)
        }
        .environment(app).preferredColorScheme(.dark).tint(SessionListStyle.amber)
        try await save(sheet, name: "upnext-pr-sheet")

        fake.controller.prepareMerge(prs[0])
        let draft = try XCTUnwrap(fake.controller.mergeDraft)
        let confirmation = IOSUpNextPrMergeContent(controller: fake.controller, draft: draft, rendersStaticFixture: true)
            .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(SessionListStyle.background).environment(app).preferredColorScheme(.dark)
        try await save(confirmation, name: "upnext-pr-merge-confirm")
    }

    private func save<V: View>(_ content: V, name: String, listed: Bool = false) async throws {
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
        var turns = 0
        while (listed ? !ready(host.view) : turns < 20), ContinuousClock.now < deadline {
            host.view.setNeedsLayout(); host.view.layoutIfNeeded()
            await Task.yield(); turns += 1
        }
        if listed { XCTAssertTrue(ready(host.view), "the PR list must show its rows") }
        let format = UIGraphicsImageRendererFormat(); format.scale = 2
        var rendered = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            rendered = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }
        XCTAssertTrue(rendered)
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent(name + ".png"))
    }
}
