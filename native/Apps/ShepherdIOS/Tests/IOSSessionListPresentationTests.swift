import XCTest
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSSessionListPresentationTests: XCTestCase {
    private let now = 1_800_000_000_000

    private func sidebar(_ sessions: [Session]) -> SidebarModel {
        let model = SidebarModel(reads: .stub, now: { 1_800_000_000_000 })
        model.install(sessions: sessions)
        return model
    }

    private func session(_ id: String, status: SessionStatusKnown = .done, repo: String = "/repos/a") -> Session {
        var session = PreviewData.session(id: id, desig: "TASK-\(id)", status: .init(known: status))
        session.repoPath = repo
        return session
    }

    private func git(_ state: PrStateKnown = .open, checks: ChecksStateKnown = .pending) throws -> GitState {
        try JSONDecoder().decode(GitState.self, from: Data("""
            {"state":"\(state.rawValue)","checks":"\(checks.rawValue)","deployConfigured":false,"number":189,"url":"https://example.com/pull/189"}
            """.utf8))
    }

    func testLifecycleOrderingUsesCoreRatherThanTaskID() {
        let model = sidebar([session("01"), session("80", status: .running), session("72"), session("99")])
        model.gitStage = { $0.id == "01" ? .merged : $0.id == "72" ? .ciRunning : nil }
        let groups = IOSSessionListPresentation.groups(model)
        XCTAssertEqual(model.lens, .all)
        XCTAssertEqual(groups.map(\.stage), [.active, .ciRunning, .merged])
        XCTAssertEqual(groups.flatMap(\.sessions).map(\.id), ["80", "99", "72", "01"])
        // Within a lifecycle group the input order is preserved, exactly as on web/Mac.
        model.toggleCollapsed(.merged)
        XCTAssertTrue(model.collapsedStages.contains(.merged))
        XCTAssertEqual(SidebarCopy.heading(groups.last!, git: [:]), L.t("herd_merged_group", "1"))
    }

    func testReadyLensExcludesWorkAndForeignHandoffsButKeepsFailedCI() {
        let model = sidebar([session("run", status: .running), session("mine"), session("foreign"), session("failed"), session("review")])
        model.gitStage = { $0.id == "foreign" ? .waitingOnReviewer : $0.id == "failed" ? .ciFailed : nil }
        model.inReview = { $0.id == "review" }
        model.lens = .ready
        XCTAssertEqual(IOSSessionListPresentation.groups(model).flatMap(\.sessions).map(\.id), ["mine", "failed"])
        model.lens = .next
        XCTAssertTrue(IOSSessionListPresentation.groups(model).isEmpty)
        model.lens = .owed
        XCTAssertTrue(IOSSessionListPresentation.groups(model).isEmpty)
    }

    func testStatusAndTimestampsPreserveServerOrderWithinLifecycleGroup() {
        var old = session("01")
        old.updatedAt = now - 100_000
        var newer = session("90")
        newer.updatedAt = now
        var working = session("50", status: .running)
        working.updatedAt = old.updatedAt
        var blocked = session("80", status: .blocked)
        blocked.updatedAt = old.updatedAt
        let model = sidebar([old, newer, blocked, working])
        XCTAssertEqual(IOSSessionListPresentation.groups(model).flatMap(\.sessions).map(\.id), ["01", "90", "80", "50"])
    }

    func testWorkingBlockedUpgradeAndRepoFiltering() async {
        let model = sidebar([session("s1", status: .blocked), session("other", repo: "/repos/b"), session("archived", status: .archived)])
        await model.refresh() // stub marks s1 as still working
        model.toggleRepo("/repos/a", additive: false)
        XCTAssertEqual(model.sessions.map(\.id), ["s1"])
        XCTAssertEqual(model.rendered(model.sessions[0]).status.known, .running)
        model.lens = .ready
        XCTAssertTrue(IOSSessionListPresentation.groups(model).isEmpty)
        model.toggleRepo("/repos/a", additive: false)
        XCTAssertEqual(model.sessions.map(\.id), ["other"])
    }

    func testBadgesUseSharedKindPRNeedsYouQuotaAndMergedMapping() throws {
        var raw = session("one")
        raw.research = true
        raw.autopilotPaused = true
        let block = BlockReason(shape: .init(value1: .quota), options: [], tail: [], quotaKind: .init(value1: .review))
        let card = IOSSessionListPresentation.card(raw, displayed: raw, git: try git(), block: block, now: now)
        XCTAssertEqual(card.badges.map(\.id), ["research", "pr", "quota", "needs-you", "answer"])
        XCTAssertEqual(card.badges.first { $0.id == "pr" }?.text, L.t("prbadge_open", "189"))
        XCTAssertEqual(card.badges.first { $0.id == "pr" }?.markers.map(\.id), ["ci"])
        let merged = IOSSessionListPresentation.card(raw, displayed: raw, git: try git(.merged), now: now)
        XCTAssertEqual(merged.badges.first { $0.id == "pr" }?.text, L.t("prbadge_merged"))
        XCTAssertEqual(merged.progress.terminal, .merged)
        XCTAssertTrue(merged.progress.segments.isEmpty)
    }

    func testAnswerCueDoesNotInventQuestionsAndEmptyOptionalFieldsStayAbsent() {
        let raw = session("a")
        let plain = IOSSessionListPresentation.card(raw, displayed: raw, now: now)
        XCTAssertTrue(plain.badges.isEmpty)
        XCTAssertNil(plain.summary)
        XCTAssertEqual(plain.metadata, raw.desig)
        var planning = raw
        planning.planPhase = .init(known: .planning)
        let questions = IOSSessionListPresentation.card(planning, displayed: planning, questionsUnanswered: true, now: now)
        XCTAssertEqual(questions.badges.map(\.id), ["plan", "answer"])
        XCTAssertEqual(questions.progress.segments.count, 5)
    }

    func testRecapSummaryAndActivityFallback() {
        let raw = session("a")
        let recap = Recap(sessionId: "a", state: .init(known: .ready), headline: "Ready for review", body: "", openItems: [], updatedAt: now)
        let activity = SessionActivitySignal(lastActivityTs: now, summary: "Reading files", recentTs: [], recentErrTs: [])
        XCTAssertEqual(IOSSessionListPresentation.card(raw, displayed: raw, recap: recap, activity: activity, now: now).summary, "Ready for review")
        XCTAssertEqual(IOSSessionListPresentation.card(raw, displayed: raw, activity: activity, now: now).summary, "Reading files")
    }

    func testFinishedLensUsesArchivedQueueAndNewestArchiveOrder() async {
        var old = session("old", status: .archived)
        old.archivedAt = now - 10_000
        var recent = session("recent", status: .archived, repo: "/repos/b")
        recent.archivedAt = now
        let rows = [old, recent]
        let queues = QueuesModel(reads: .init(held: { [] }, done: { rows }, recaps: { [:] }, stranded: { [] }, refreshUpNext: {}))
        await queues.refresh(recomputeUpNext: false)
        XCTAssertEqual(IOSSessionListPresentation.finished(queues.finishedSessions, repos: []).map(\.id), ["recent", "old"])
        XCTAssertEqual(IOSSessionListPresentation.finished(queues.finishedSessions, repos: ["/repos/a"]).map(\.id), ["old"])
    }

    func testOwedCountAndRowsUseSameRepoScopedRecords() {
        let one = PostMergeSteps(sessionId: "a", desig: "TASK-a", repoPath: "/repos/a", prNumber: 1, prTitle: "a", steps: [], trackingIssueUrl: nil, trackingIssueNumber: nil, createdAt: now, updatedAt: now, clearedAt: nil)
        var cleared = one
        cleared.sessionId = "cleared"
        cleared.clearedAt = now
        var other = one
        other.sessionId = "b"
        other.repoPath = "/repos/b"
        XCTAssertEqual(IOSSessionListPresentation.outstanding([one, cleared, other], repos: []).count, 2)
        XCTAssertEqual(IOSSessionListPresentation.outstanding([one, cleared, other], repos: ["/repos/a"]).map(\.sessionId), ["a"])
    }

    func testModelMetadataPrefersObservedIdentityAndDoesNotResolveFloatingAlias() {
        var raw = session("a", status: .running)
        raw.model = "sonnet"
        raw.runtimeModel = "claude-opus-5-5"
        raw.effort = "high"
        var card = IOSSessionListPresentation.card(raw, displayed: raw, now: now)
        XCTAssertEqual(card.metadata, "\(raw.desig) · Opus 5.5 · \(L.t("effort_label_high"))")
        XCTAssertEqual(card.heartbeat.count, 24)
        var live = SessionActivitySignal(lastActivityTs: now, summary: nil, recentTs: [], recentErrTs: [])
        live.runtimeModel = "claude-sonnet-5-5"
        live.runtimeEffort = "low"
        let latest = IOSSessionListPresentation.card(raw, displayed: raw, activity: live, now: now)
        XCTAssertEqual(latest.metadata, "\(raw.desig) · Sonnet 5.5 · \(L.t("effort_label_low"))")
        raw.runtimeModel = nil
        raw.effort = nil
        card = IOSSessionListPresentation.card(raw, displayed: raw, now: now)
        XCTAssertEqual(card.metadata, "\(raw.desig) · sonnet")
    }

    func testActivityStripUsesSharedBinsOnlyForDisplayedLiveWork() {
        let raw = session("a", status: .blocked)
        var displayed = raw
        displayed.status = .init(known: .running)
        let activity = SessionActivitySignal(lastActivityTs: now, summary: "Read", recentTs: [now], recentErrTs: [now])
        let working = IOSSessionListPresentation.card(raw, displayed: displayed, activity: activity, now: now)
        XCTAssertTrue(working.heartbeat.last!.error)
        XCTAssertTrue(working.heartbeat.last!.newest)
        XCTAssertEqual(working.heartbeat.last!.level, 1)
        XCTAssertTrue(IOSSessionListPresentation.card(raw, displayed: raw, activity: activity, now: now).heartbeat.isEmpty)
    }

    func testGroupExplanationUsesWebCopyAndDoesNotInventMissingHelp() {
        XCTAssertEqual(IOSSessionListPresentation.groupHelp(.reviewerRunning), L.t("herd_help_reviewing"))
        XCTAssertEqual(IOSSessionListPresentation.groupHelp(.awaitingMerge), L.t("herd_help_your_turn"))
        XCTAssertNil(IOSSessionListPresentation.groupHelp(.needsRework))
        XCTAssertNil(IOSSessionListPresentation.groupHelp(.branchProtectionBlocked))
    }

    func testElapsedThresholdsAndFutureClock() {
        XCTAssertEqual(IOSSessionListPresentation.elapsed(now + 1_000, now: now), "00:00")
        XCTAssertEqual(IOSSessionListPresentation.elapsed(now - 59_000, now: now), "00:59")
        XCTAssertEqual(IOSSessionListPresentation.elapsed(now - 3_600_000, now: now), "1h 00m")
        XCTAssertEqual(IOSSessionListPresentation.elapsed(now - 86_400_000, now: now), "1d 00h")
    }

    func testIOSCopyResolvesInBothLocales() {
        let keys = ["native_ios_open_session_hint", "native_ios_group_expanded", "native_ios_next_waiting", "actionbar_backlog", "topbar_settings_aria", "herd_help_reviewing", "newtask_info_aria"]
        for locale in ["en", "de"] {
            let path = CoreResources.bundle.path(forResource: locale, ofType: "lproj")!
            let bundle = Bundle(path: path)!
            for key in keys {
                XCTAssertNotEqual(bundle.localizedString(forKey: key, value: nil, table: nil), key)
            }
        }
    }
}
