import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore
extension CoreSeamTests {
/// Mirrors ui/src/lib/components/viewport/pr-action-row.test.ts.
struct MergeRowRulesTests {
    func git(_ extra: [String: Any] = [:]) throws -> GitState {
        var payload: [String: Any] = ["state": "open", "checks": "success", "deployConfigured": false, "number": 7]
        payload.merge(extra) { $1 }
        return try JSONDecoder().decode(GitState.self, from: JSONSerialization.data(withJSONObject: payload))
    }
    func verdict(_ decision: String) throws -> ReviewVerdict {
        try JSONDecoder().decode(ReviewVerdict.self, from: JSONSerialization.data(withJSONObject:
            ["sessionId": "a", "headSha": "h", "decision": decision, "summary": "", "body": "", "findings": [],
             "addressRound": 0, "addressCap": 0, "finalRoundPending": false, "finalRoundTimeoutMs": 0, "updatedAt": 1]))
    }

    @Test func visibleForAnOpenOrMergedNumberedPR() throws {
        #expect(MergeRowRules.visible(try git()))
        #expect(MergeRowRules.visible(try git(["state": "merged"])))
        #expect(!MergeRowRules.visible(try git(["state": "closed"])))
        #expect(!MergeRowRules.visible(try git(["number": NSNull()])))
        #expect(!MergeRowRules.visible(nil))
    }

    @Test func statePrecedenceMatchesTheWeb() throws {
        #expect(MergeRowRules.kind(try git(), merging: false) == .ready)
        #expect(MergeRowRules.kind(try git(["state": "merged", "checks": "failure"]), merging: true) == .merged)
        #expect(MergeRowRules.kind(try git(["checks": "failure", "isDraft": true]), merging: true) == .merging)
        #expect(MergeRowRules.kind(try git(["inMergeQueue": true]), merging: false) == .merging)
        #expect(MergeRowRules.kind(try git(["checks": "failure", "isDraft": true]), merging: false) == .draft)
        #expect(MergeRowRules.kind(try git(["checks": "failure", "mergeStateStatus": "dirty"]), merging: false) == .conflict)
        #expect(MergeRowRules.kind(try git(["checks": "pending", "mergeStateStatus": "behind"]), merging: false) == .behind)
        #expect(MergeRowRules.kind(try git(["checks": "failure", "mergeStateStatus": "blocked"]), merging: false) == .ciFailed)
        #expect(MergeRowRules.kind(try git(["checks": "pending", "mergeStateStatus": "blocked"]), merging: false) == .ciRunning)
        #expect(MergeRowRules.kind(try git(["mergeStateStatus": "blocked"]), merging: false) == .protected)
        // Strict lock: a failing non-required check GitHub reports as `unstable` still locks.
        #expect(MergeRowRules.kind(try git(["checks": "failure", "mergeStateStatus": "unstable"]), merging: false) == .ciFailed)
    }

    @Test func onlyReadyIsUnlockedAndEveryLockNamesItsReason() {
        let kinds: [MergeRowRules.Kind] = [.merging, .draft, .conflict, .behind, .ciFailed, .ciRunning, .protected]
        for kind in kinds {
            let text = MergeRowRules.blockedText(kind)
            #expect(text != nil && text?.hasPrefix("gitrail_") == false)
        }
        #expect(MergeRowRules.blockedText(.ready) == nil)
        #expect(MergeRowRules.blockedText(.merged) == nil)
        #expect(MergeRowRules.label(.merged, base: "main") == L.t("prrow_state_merged"))
        #expect(MergeRowRules.facts(try! git(["state": "merged"]), verdict: nil, reviewing: false, base: "main").isEmpty)
        #expect(MergeRowRules.blockedText(.ciRunning) == L.t("gitrail_merge_blocked_pending"))
        #expect(MergeRowRules.label(.behind, base: "main").contains("main"))
        #expect(MergeRowRules.label(.ready, base: "main") == L.t("gitrail_ready_to_merge"))
    }

    @Test func factsLeaveOutWhatWasNotMeasured() throws {
        let clean = MergeRowRules.facts(try git(["mergeStateStatus": "clean"]), verdict: try verdict("commented"),
            reviewing: false, base: "main")
        #expect(clean.map(\.id) == [.ci, .critic, .base, .conflicts])
        #expect(clean.allSatisfy { $0.tone == .ok })
        #expect(clean[2].text.contains("main"))
        let unknown = MergeRowRules.facts(try git(["checks": "none", "mergeStateStatus": "unknown"]), verdict: nil,
            reviewing: false, base: "main")
        #expect(unknown.map(\.id) == [.ci])
        #expect(unknown[0].tone == .pending)
        let behind = MergeRowRules.facts(try git(["mergeStateStatus": "behind", "mergeable": true]), verdict: try verdict("changes_requested"),
            reviewing: false, base: "develop")
        #expect(behind.map(\.tone) == [.ok, .fail, .fail, .ok])
        #expect(behind.map(\.glyph) == ["✓", "✗", "✗", "✓"])
        let reviewing = MergeRowRules.facts(try git(["mergeStateStatus": "dirty"]), verdict: try verdict("commented"),
            reviewing: true, base: "main")
        #expect(reviewing.map(\.id) == [.ci, .critic, .conflicts])
        #expect(reviewing[1].text == L.t("prrow_fact_critic_reviewing"))
        #expect(reviewing[2].tone == .fail)
        // A Gitea draft reports mergeable:false; that is not a conflict.
        #expect(MergeRowRules.facts(try git(["mergeable": false, "isDraft": true]), verdict: nil, reviewing: false, base: "main")
            .map(\.id) == [.ci])
    }

    @Test func checksClearedMatchesTheServer() throws {
        #expect(MergeRowRules.checksCleared(try git()))
        #expect(MergeRowRules.checksCleared(try git(["checks": "none", "noCi": true])))
        #expect(!MergeRowRules.checksCleared(try git(["checks": "none"])))
        #expect(!MergeRowRules.checksCleared(try git(["checks": "pending", "noCi": true])))
    }

    // Mirrors ui/src/lib/components/viewport/pr-next-step.test.ts.
    @Test func nextStepMatchesTheWeb() {
        typealias R = MergeRowRules
        let fix = R.nextStep(.ciFailed, autopilot: false, criticReviewing: false, live: true)
        #expect(fix == .init(action: .fixCI, mode: .button, reason: nil))
        #expect(R.nextStep(.ciFailed, autopilot: true, criticReviewing: true, live: false)
            == .init(action: .fixCI, mode: .passive, reason: L.t("prrow_passive_ci")))
        #expect(R.nextStep(.ciFailed, autopilot: false, criticReviewing: true, live: false)
            == .init(action: .fixCI, mode: .locked, reason: L.t("prrow_locked_critic")))
        #expect(R.nextStep(.ciFailed, autopilot: false, criticReviewing: false, live: false)
            == .init(action: .fixCI, mode: .locked, reason: L.t("prrow_locked_not_live")))
        for kind in [R.Kind.behind, .conflict] {
            #expect(R.nextStep(kind, autopilot: false, criticReviewing: true, live: true) == .init(action: .rebase, mode: .button, reason: nil))
            #expect(R.nextStep(kind, autopilot: true, criticReviewing: false, live: true)
                == .init(action: .rebase, mode: .passive, reason: L.t("prrow_passive_rebase")))
            #expect(R.nextStep(kind, autopilot: false, criticReviewing: false, live: false)
                == .init(action: .rebase, mode: .locked, reason: L.t("prrow_locked_not_live")))
        }
        #expect(R.nextStep(.merged, autopilot: true, criticReviewing: true, live: false) == .init(action: .decommission, mode: .button, reason: nil))
        for kind in [R.Kind.ready, .ciRunning, .draft, .protected, .merging] {
            #expect(R.nextStep(kind, autopilot: false, criticReviewing: false, live: true).action == .merge)
        }
    }

    @Test func onlyALiveAgentIsSteerable() {
        var session = PreviewData.session(name: "steer")
        for status in [SessionStatusKnown.running, .idle, .blocked] {
            session.status = .init(known: status)
            #expect(MergeRowRules.agentLive(session, alive: nil))
            #expect(MergeRowRules.agentLive(session, alive: true))
            #expect(!MergeRowRules.agentLive(session, alive: false))
        }
        for status in [SessionStatusKnown.done, .archived] {
            session.status = .init(known: status)
            #expect(!MergeRowRules.agentLive(session, alive: true))
        }
        session.status = .init(known: .running); session.terminal = true
        #expect(!MergeRowRules.agentLive(session, alive: true))
    }

    @Test func steersMatchTheWebText() throws {
        let red = try git(["checks": "failure", "headSha": "abcdef1234"])
        #expect(MergeRowRules.steer(.fixCI, git: red, base: "main") ==
            "Shepherd: CI is failing on PR #7 (head abcdef1): run `gh pr checks 7` once for the failing checks. Read the logs with "
            + "`gh run view <run-id> --log-failed`, fix the root cause, rebase onto your PR's base and push. "
            + "Don't watch the new run — Shepherd steers you when it finishes.")
        #expect(MergeRowRules.steer(.rebase, git: try git(["mergeStateStatus": "behind"]), base: "main") ==
            "Shepherd: your PR is behind main. Fetch origin and rebase your branch onto origin/main (never merge it in) "
            + "and push with --force-with-lease.")
        #expect(MergeRowRules.steer(.rebase, git: try git(["mergeStateStatus": "dirty"]), base: "dev") ==
            "Shepherd: your PR is in conflict with dev. Fetch origin and rebase your branch onto origin/dev (never merge it in), "
            + "resolve the conflicts and push with --force-with-lease.")
        #expect(MergeRowRules.steer(.decommission, git: red, base: "main") == nil)
        #expect(MergeRowRules.steer(.merge, git: red, base: "main") == nil)
    }

    @Test func logsOpenThePRChecksTab() throws {
        #expect(MergeRowRules.logsURL(try git(["url": "https://github.com/o/r/pull/7/"]))?.absoluteString
            == "https://github.com/o/r/pull/7/checks")
        #expect(MergeRowRules.logsURL(try git(["url": "javascript:alert(1)"])) == nil)
        #expect(MergeRowRules.logsURL(try git()) == nil)
    }
}
}
