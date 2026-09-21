import Foundation
import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
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
}
