import Foundation
import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd

@MainActor
struct HerdBadgesTests {
    private func session(_ provider: AgentProvider? = .claude) -> Session {
        PreviewData.session(status: .init(known: .idle), agentProvider: provider)
    }

    private func git(_ state: PrStateKnown = .open, checks: ChecksStateKnown = .success) -> GitState {
        var git = GitState(state: .init(known: state), checks: .init(known: checks), deployConfigured: false)
        git.number = 42
        return git
    }

    private func verdict(_ decision: ReviewDecisionKnown = .changesRequested) -> ReviewVerdict {
        ReviewVerdict(sessionId: "s1", headSha: "head", decision: .init(known: decision),
            summary: "review", body: "review", findings: [], addressRound: 0, addressCap: 3,
            finalRoundPending: false, finalRoundTimeoutMs: 100, updatedAt: 1_000)
    }

    @Test func cliShowsOnEveryRowOnlyWhenVisibleProvidersDiffer() {
        let legacy = session(nil)
        #expect(!SessionBadges.showsCli(for: []))
        #expect(!SessionBadges.showsCli(for: [session(), legacy]))
        #expect(!SessionBadges.showsCli(for: [session(.codex), session(.codex)]))
        #expect(SessionBadges.showsCli(for: [legacy, session(.codex)]))
        for (row, key) in [(legacy, "clibadge_label_claude"), (session(.codex), "clibadge_label_codex")] as [(Session, StaticString)] {
            let badges = SessionBadges.items(for: row, block: nil, showCli: true)
            #expect(badges.first?.id == "cli")
            #expect(badges.first?.text == L.t(key))
            #expect(SessionBadges.items(for: row, block: nil, showCli: false).isEmpty)
        }
    }

    @Test func issueNeedsANumberAndUsesTheFirstSafeUrl() throws {
        var row = session()
        var state = git()
        state.issueUrl = "https://forge.example/issues/7"
        #expect(SessionBadges.issue(row, git: state) == nil)
        row.issueNumber = 7
        #expect(SessionBadges.issue(row, git: nil)?.text == L.t("issuebadge_label", "7"))
        #expect(SessionBadges.issue(row, git: nil)?.url == nil)
        row.additionalProperties = try .init(unvalidatedValue: ["issueUrl": "https://old.example/issues/7"])
        #expect(SessionBadges.issue(row, git: state)?.url?.host == "forge.example")
        state.issueUrl = "javascript:alert(1)"
        #expect(SessionBadges.issue(row, git: state)?.url?.host == "old.example")
        row.additionalProperties = try .init(unvalidatedValue: [
            "launchMetadata": ["issue": ["url": "https://launch.example/issues/7"]],
        ])
        #expect(SessionBadges.issue(row, git: nil)?.url?.host == "launch.example")
    }

    @Test func prBadgeHasStateCiReviewDraftAndStaleMarkers() throws {
        #expect(SessionBadges.pr(nil) == nil)
        #expect(SessionBadges.pr(git(.none)) == nil)
        var state = git(checks: .failure)
        state.isDraft = true
        state.latestReview = .init(state: .init(value1: .changesRequested), author: "alex", submittedAt: 0)
        var badge = try #require(SessionBadges.pr(state))
        #expect(badge.text == L.t("prbadge_open", "42"))
        #expect(badge.markers.map(\.id) == ["ci", "review", "draft"])
        #expect(badge.markers[0].tint == .red)
        #expect(badge.markers[0].symbol == "xmark.circle.fill")
        #expect(badge.markers[1].text == L.t("prbadge_review_changes"))
        state.isDraft = false
        state.mergeStateStatus = .init(known: .behind)
        badge = try #require(SessionBadges.pr(state))
        #expect(badge.markers.last?.text == L.t("prbadge_behind"))
        state.mergeStateStatus = .init(known: .dirty)
        #expect(SessionBadges.pr(state)?.markers.last?.text == L.t("prbadge_conflict"))
        state.checks = .init(known: .none)
        #expect(SessionBadges.pr(state)?.markers.contains { $0.id == "ci" } == false)
        for (terminal, key) in [(PrStateKnown.merged, "prbadge_merged"), (.closed, "prbadge_closed")] as [(PrStateKnown, StaticString)] {
            state.state = .init(known: terminal)
            #expect(SessionBadges.pr(state)?.text == L.t(key))
            #expect(SessionBadges.pr(state)?.markers.map(\.id) == ["review"])
        }
    }

    @Test func criticSelectsExactlyOneVerdictRoundFinalStalledOrReviewingLabel() throws {
        #expect(SessionBadges.critic(nil, reviewing: false, now: 0) == nil)
        for (decision, key) in [(ReviewDecisionKnown.changesRequested, "criticbadge_changes"),
                                (.commented, "criticbadge_commented"), (.error, "criticbadge_error")] as [(ReviewDecisionKnown, StaticString)] {
            let review = verdict(decision)
            #expect(SessionBadges.critic(review, reviewing: false, now: 0)?.text == L.t(key))
            #expect(SessionBadges.critic(review, reviewing: true, now: 0)?.text == L.t("criticbadge_reviewing"))
        }
        var review = verdict()
        review.addressRound = 9
        review.findings = [.init()]
        var badge = try #require(SessionBadges.critic(review, reviewing: false, now: 1_050))
        #expect(badge.text == L.t("criticbadge_stalled"))
        #expect(badge.markers.isEmpty)
        review.finalRoundPending = true
        badge = try #require(SessionBadges.critic(review, reviewing: false, now: 1_050))
        #expect(badge.text == L.t("criticbadge_final"))
        #expect(badge.markers.isEmpty)
        for reviewing in [false, true] {
            let final = try #require(SessionBadges.critic(review, reviewing: reviewing, now: 1_050))
            #expect(final.text == L.t("criticbadge_final"))
            #expect(final.markers.isEmpty)
            let expired = try #require(SessionBadges.critic(review, reviewing: reviewing, now: 1_101))
            #expect(expired.text == L.t(reviewing ? "criticbadge_reviewing" : "criticbadge_stalled"))
            #expect(expired.tint == (reviewing ? Color.orange : Color.red))
            #expect(expired.markers.isEmpty)
        }
        review.addressRound = 2
        review.finalRoundPending = false
        for reviewing in [false, true] {
            let round = try #require(SessionBadges.critic(review, reviewing: reviewing, now: 1_050))
            #expect(round.text == L.t("criticbadge_round", "2", "3"))
            #expect(round.markers.isEmpty)
        }
        // Over-cap error streaks without findings remain a round, with a clamped numerator.
        review.addressRound = 9
        review.findings = []
        review.decision = .init(known: .error)
        #expect(SessionBadges.critic(review, reviewing: false, now: 1_050)?.text == L.t("criticbadge_round", "3", "3"))
    }

    @Test func heartbeatBucketsRecentActivityAndTintsOnlyMatchingErrors() {
        let now = 1_000_000
        let activity = SessionActivitySignal(lastActivityTs: now, summary: nil,
            recentTs: [0, now + 1, now - 480_000, now - 479_999, now - 25_000, now],
            recentErrTs: [now - 25_000, now + 1])
        let cells = HerdHeartbeat.cells(activity, now: now)
        #expect(cells.count == 24)
        #expect(cells[0].level == 1)
        #expect(cells[22].error)
        #expect(cells[22].tint == .red)
        #expect(cells[22].label == L.t("heartbeat_legend_error_label"))
        #expect(cells[23].newest)
        #expect(!cells[23].error)
        #expect(cells.filter { $0.level > 0 }.count == 3)
        // The formerly future timestamp enters the window as the clock advances.
        #expect(HerdHeartbeat.cells(activity, now: now + 480_000).filter { $0.level > 0 }.count == 1)
        #expect(HerdHeartbeat.cells(activity, now: now + 480_001).allSatisfy { $0.level == 0 })
        #expect(HerdHeartbeat.cells(nil, now: now).allSatisfy { $0.level == 0 })
    }

    @Test func autopilotHasPausedCompleteUnavailablePriorityAndReviewSuppressesAll() throws {
        var row = session(.codex)
        row.autopilotEnabled = true
        #expect(SessionBadges.autopilot(row, reviewing: false)?.text == L.t("session_autopilot_unavailable_label"))
        row.autopilotComplete = true
        #expect(SessionBadges.autopilot(row, reviewing: false)?.text == L.t("session_autopilot_complete_label"))
        row.autopilotPaused = true
        #expect(SessionBadges.autopilot(row, reviewing: false)?.id == "needs-you")
        #expect(SessionBadges.autopilot(row, reviewing: true) == nil)
        #expect(SessionBadges.items(for: row, block: nil, reviewing: true).contains { $0.id == "needs-you" } == false)
        row.autopilotPaused = false
        row.autopilotComplete = false
        row.providerSessionId = "conversation"
        row.additionalProperties = try .init(unvalidatedValue: ["codexLaunchId": "launch"])
        #expect(SessionBadges.autopilot(row, reviewing: false) == nil)
        row.providerSessionId = nil
        row.research = true
        #expect(SessionBadges.autopilot(row, reviewing: false) == nil)
        row.research = false
        row.autopilotEnabled = false
        #expect(SessionBadges.autopilot(row, reviewing: false) == nil)
        row.autopilotEnabled = nil
        #expect(SessionBadges.autopilot(row, reviewing: false, repoDefault: true) != nil)
        #expect(SessionBadges.autopilot(session(), reviewing: false, repoDefault: true) == nil)
    }

    @Test func statusChipIsMutuallyExclusiveInWebOrder() {
        var row = session()
        row.readyToMerge = true
        row.mergingSince = 1_000
        var state = git()
        state.mergeStateStatus = .init(known: .blocked)
        state.reviewBlock = .init(reviewer: "alex", state: .changesRequested)
        @MainActor func status() -> [SessionBadge] {
            SessionBadges.items(for: row, block: nil, git: state, now: 1_010).filter { $0.id == "status" }
        }
        #expect(status().count == 1)
        #expect(status().first?.text == L.t("unitrow_changes_requested", "alex"))
        state.reviewBlock = nil
        #expect(status().count == 1)
        #expect(status().first?.text == L.t("unitrow_merge_blocked"))
        state.mergeStateStatus = nil
        #expect(status().count == 1)
        #expect(status().first?.text == L.t("status_merging"))
        row.mergingSince = nil
        #expect(status().count == 1)
        #expect(status().first?.text == L.t("status_ready_to_merge"))
        row.readyToMerge = false
        #expect(status().isEmpty)
    }

    @Test func statusUsesRawIdleOpenClearedAndOnlyTheReviewFlag() {
        var row = session()
        var state = git()
        state.reviewBlock = .init(reviewer: "alex", state: .changesRequested)
        #expect(SessionBadges.status(row, git: state, reviewing: true, now: 0) == nil)
        for raw in [SessionStatusKnown.running, .blocked] {
            row.status = .init(known: raw)
            #expect(SessionBadges.status(row, git: state, reviewing: false, now: 0) == nil)
        }
        row.status = .init(known: .idle)
        state.checks = .init(known: .none)
        #expect(SessionBadges.status(row, git: state, reviewing: false, now: 0) == nil)
        state.noCi = true
        #expect(SessionBadges.status(row, git: state, reviewing: false, now: 0) != nil)
        state.state = .init(known: .closed)
        #expect(SessionBadges.status(row, git: state, reviewing: false, now: 0) == nil)
    }

    @Test func gitRailRequiresGitAndIncludesPrNumberStateAndMergeBlockers() throws {
        #expect(HerdRowGit.presentation(nil) == nil)
        var state = git(checks: .failure)
        state.mergeStateStatus = .init(known: .dirty)
        let rail = try #require(HerdRowGit.presentation(state))
        #expect(rail.pr?.text == L.t("prbadge_open", "42"))
        #expect(rail.blockers.map(\.text) == [L.t("gitrail_merge_blocked_conflict")])
        state.state = .init(known: .merged)
        let merged = try #require(HerdRowGit.presentation(state))
        #expect(merged.pr?.text == L.t("prbadge_merged"))
        #expect(merged.number == L.t("prbadge_open", "42"))
        #expect(merged.blockers.isEmpty)
    }

    @Test func gitRailUsesAuthoritativeMergeStatusBeforeFallingBackToChecks() throws {
        let cases: [(String?, ChecksStateKnown, StaticString?)] = [
            ("unstable", .failure, nil), ("clean", .failure, nil),
            ("has_hooks", .failure, nil), ("future-status", .failure, nil),
            ("unknown", .failure, "gitrail_merge_blocked_checks"),
            (nil, .failure, "gitrail_merge_blocked_checks"),
            ("", .failure, "gitrail_merge_blocked_checks"),
            ("unknown", .pending, nil), (nil, .success, nil),
            ("blocked", .success, "gitrail_merge_blocked_protected"),
            ("behind", .failure, "gitrail_merge_blocked_behind"),
            ("dirty", .failure, "gitrail_merge_blocked_conflict"),
        ]
        for (status, checks, reason) in cases {
            var state = git(checks: checks)
            state.mergeable = true
            state.mergeStateStatus = status.map { .init(value1: MergeStateStatusKnown(rawValue: $0), value2: $0) }
            let rail = try #require(HerdRowGit.presentation(state))
            #expect(rail.blockers.map(\.text) == reason.map { [L.t($0)] } ?? [], "status=\(status ?? "nil")")
            state.state = .init(known: .closed)
            #expect(HerdRowGit.presentation(state)?.blockers.isEmpty == true)
        }
        var state = git(checks: .failure)
        state.mergeStateStatus = .init(known: .unstable)
        state.mergeable = false
        #expect(HerdRowGit.presentation(state)?.blockers.first?.text == L.t("gitrail_merge_blocked_conflict"))
        state.isDraft = true
        #expect(HerdRowGit.presentation(state)?.blockers.map(\.text) == [L.t("gitrail_merge_blocked_draft")])
    }

    @Test func badgeTintsMatchWebSemantics() throws {
        var state = git(checks: .pending)
        state.latestReview = .init(state: .init(value1: .commented), author: "alex", submittedAt: 0)
        var row = session(.codex)
        row.autopilotEnabled = true
        row.mergingSince = 1_000
        let badges: [(SessionBadge?, Color)] = [
            (SessionBadges.critic(nil, reviewing: true, now: 0), .orange),
            (SessionBadges.critic(verdict(.commented), reviewing: false, now: 0), .blue),
            (SessionBadges.critic(verdict(.error), reviewing: false, now: 0), .secondary.opacity(0.65)),
            (SessionBadges.critic(verdict(), reviewing: false, now: 0), .orange),
            (SessionBadges.autopilot(row, reviewing: false), .secondary),
            (SessionBadges.status(row, git: nil, reviewing: false, now: 1_010), .orange),
            (SessionBadges.pr(git(.merged)), .secondary),
            (SessionBadges.pr(git(.closed)), .secondary.opacity(0.65)),
        ]
        for (badge, color) in badges { #expect(try #require(badge).tint == color) }
        #expect(SessionBadges.ci(state)?.tint == .orange)
        #expect(SessionBadges.pr(state)?.markers.first { $0.id == "review" }?.tint == .blue)
        row.autopilotPaused = true
        #expect(SessionBadges.autopilot(row, reviewing: false)?.tint == .orange)
        row.autopilotPaused = false
        row.autopilotComplete = true
        #expect(SessionBadges.autopilot(row, reviewing: false)?.tint == .green)
    }

    @Test func productionRowUsesRepositoryDefaultsAndExplicitSessionOverrides() throws {
        let herd = HerdSignals(reads: .stub(), now: { 0 })
        defer { herd.teardown() }
        var row = session(.codex)
        row.autopilotEnabled = nil
        #expect(herd.repoAutopilotDefault(row.repoPath) == nil)
        @MainActor func autopilot() -> SessionBadge? {
            HerdRowSignals.presentation(for: row, herd: herd, block: nil, showCli: false, now: 0)
                .badges.first { $0.id == "autopilot" }
        }
        #expect(autopilot() == nil) // Unknown config cannot claim autopilot is enabled.
        let path = row.repoPath
        herd.repoAutopilotDefault = { $0 == path }
        #expect(autopilot()?.text == L.t("session_autopilot_unavailable_label"))
        row.autopilotEnabled = false
        #expect(autopilot() == nil)
        herd.repoAutopilotDefault = { _ in false }
        row.autopilotEnabled = true
        #expect(autopilot() != nil)
        row.autopilotEnabled = nil
        #expect(autopilot() == nil)
    }
}
