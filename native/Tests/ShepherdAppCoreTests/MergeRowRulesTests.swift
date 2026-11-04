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

    @Test func visibleOnlyForAnOpenNumberedPR() throws {
        #expect(MergeRowRules.visible(try git()))
        #expect(!MergeRowRules.visible(try git(["state": "merged"])))
        #expect(!MergeRowRules.visible(try git(["number": NSNull()])))
        #expect(!MergeRowRules.visible(nil))
    }

    @Test func statePrecedenceMatchesTheWeb() throws {
        #expect(MergeRowRules.kind(try git(), merging: false) == .ready)
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
}
}
